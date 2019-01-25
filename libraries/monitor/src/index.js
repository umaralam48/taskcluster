const debug = require('debug')('taskcluster-lib-monitor');
const assert = require('assert');
const rootdir = require('app-root-dir');
const fs = require('fs');
const path = require('path');
const stream = require('stream');
const mozlog = require('mozlog');
const TimeKeeper = require('./timekeeper');

class Monitor {
  /**
   * Create a new monitor, given options:
   * {
   *   projectName: '...',
   *   patchGlobal:  true,
   *   bailOnUnhandledRejection: false,
   *   resourceInterval: 10, // seconds
   *   mock: false,
   *   enable: true,
   *   gitVersion: undefined, // git version (for correlating errors); or..
   *   gitVersionFile: '.git-version', // file containing git version (relative to app root)
   * }
   */
  constructor({
    projectName,
    patchGlobal = true,
    bailOnUnhandledRejection = false,
    resourceInterval = 10,
    mock = false,
    enable = true,
    gitVersionFile = '.git-version',
    processName = null,
    level = 'INFO',
    subject = 'root',
    metadata = {
      gitVersion: null,
    },
    ...extra
  }) {
    assert(projectName, 'Must provide a project name (this is now `projectName` instead of `project`)');
    assert(!extra.credentials && !extra.statsumToken && !extra.sentryDSN, 'Credentials are no longer required for lib-monitor.');
    assert(!extra.process, 'monitor.process is now monitor.processName');

    this.projectName = projectName;
    this.mock = mock;
    this.enable = enable;
    this.level = level;
    this.subject = subject;
    this.metadata = metadata;

    let outputDest;
    if (mock) {
      this.events = [];
      outputDest = new stream.Writable({
        write: (chunk, encoding, next) => {
          this.events.push(JSON.parse(chunk));
          next();
        },
      });
    } else if (!enable) {
      outputDest = new stream.Writable({
        write: (chunk, encoding, next) => {
          next();
        },
      });
    } else {
      outputDest = process.stdout;
    }

    const logger = mozlog({
      app: `${projectName}.${subject}`,
      level: level,
      stream: outputDest,
      uncaught: 'ignore', // We handle this ourselves
    });

    this.log = logger();

    // read gitVersionFile, if gitVersion is not set
    if (!metadata.gitVersion) {
      gitVersionFile = path.resolve(rootdir.get(), gitVersionFile);
      try {
        metadata.gitVersion = fs.readFileSync(gitVersionFile).toString().trim();
      } catch (err) {
        // ignore error - we just get no gitVersion
      }
    }

    if (patchGlobal) {
      this.uncaughtExceptionHandler = this._uncaughtExceptionHandler.bind(this);
      process.on('uncaughtException', this.uncaughtExceptionHandler);

      this.unhandledRejectionHandler = this._unhandledRejectionHandler.bind(this);
      process.on('unhandledRejection', this.unhandledRejectionHandler);
    }

    if (processName) {
      this.resources(processName, resourceInterval);
    }
  }

  _uncaughtExceptionHandler(err) {
    this.reportError(err);
    process.exit(1);
  }

  _unhandledRejectionHandler(reason, p) {
    const err = 'Unhandled Rejection at: Promise ' + p + ' reason: ' + reason;
    if (!bailOnUnhandledRejection) {
      this.reportError(err, 'error', {sort: 'unhandledRejection'});
      return;
    }
    this.reportError(err, 'fatal', {});
    process.exit(1);
  }

  /*
   * TODO
   */
  terminate() {
    this.log.removeAllHandlers();
    this.stopResourceMonitoring();
    process.removeListener('uncaughtException', this.uncaughtExceptionHandler);
    process.removeListener('unhandledRejection', this.unhandledRejectionHandler);
  }

  timer(key, funcOrPromise) {
    const start = process.hrtime();
    const done = (x) => {
      const d = process.hrtime(start);
      this.measure(key, d[0] * 1000 + d[1] / 1000000);
    };
    if (funcOrPromise instanceof Function) {
      try {
        funcOrPromise = funcOrPromise();
      } catch (e) {
        // If this is a sync function that throws, we let it...
        // We just remember to call done() afterwards
        done();
        throw e;
      }
    }
    Promise.resolve(funcOrPromise).then(done, done);
    return funcOrPromise;
  }

  /**
   * Given a function that operates on a single message, this will wrap it such
   * that it will time itself.
   */
  timedHandler(name, handler) {
    return async (message) => {
      const start = process.hrtime();
      let success = 'success';
      try {
        await handler(message);
      } catch (e) {
        success = 'error';
        throw e;
      } finally {
        const d = process.hrtime(start);
        for (let stat of [success, 'all']) {
          const k = [name, stat].join('.');
          this.measure(k, d[0] * 1000 + d[1] / 1000000);
          this.count(k);
        }
      }
    };
  }

  /**
   * Given an express api method, this will time it
   * and report via the monitor.
   */
  expressMiddleware(name) {
    return (req, res, next) => {
      let sent = false;
      const start = process.hrtime();
      const send = () => {
        try {
          // Avoid sending twice
          if (sent) {
            return;
          }
          sent = true;

          const d = process.hrtime(start);

          let success = 'success';
          if (res.statusCode >= 500) {
            success = 'server-error';
          } else if (res.statusCode >= 400) {
            success = 'client-error';
          }

          for (let stat of [success, 'all']) {
            const k = [name, stat].join('.');
            this.measure(k, d[0] * 1000 + d[1] / 1000000);
            this.count(k);
          }
          this.measure(['all', success], d[0] * 1000 + d[1] / 1000000);
          this.count(['all', success]);
        } catch (e) {
          debug('Error while compiling response times: %s, %j', err, err, err.stack);
        }
      };
      res.once('finish', send);
      res.once('close', send);
      next();
    };
  }

  timeKeeper(name) {
    return new TimeKeeper(this, name);
  }

  /**
   * Patch an AWS service (an instance of a service from aws-sdk)
   */
  patchAWS(service) {
    const monitor = this.prefix(service.serviceIdentifier);
    const makeRequest = service.makeRequest;
    service.makeRequest = function(operation, params, callback) {
      const r = makeRequest.call(this, operation, params, callback);
      r.on('complete', () => {
        const requestTime = (new Date()).getTime() - r.startTime.getTime();
        monitor.measure(`global.${operation}.duration`, requestTime);
        monitor.count(`global.${operation}.count`, 1);
        if (service.config && service.config.region) {
          const region = service.config.region;
          monitor.measure(`${region}.${operation}.duration`, requestTime);
          monitor.count(`${region}.${operation}.count`, 1);
        }
      });
      return r;
    };
  }

  /**
   * Monitor a one-shot process.  This function's promise never resolves!
   * (except in testing, with MockMonitor)
   */
  async oneShot(name, fn) {
    let exitStatus = 0;

    try {
      try {
        assert.equal(typeof name, 'string');
        assert.equal(typeof fn, 'function');

        await this.timer(`${name}.duration`, fn);
        this.count(`${name}.done`);
      } catch (err) {
        this.reportError(err);
        exitStatus = 1;
      }
    } finally {
      if (!this.mock || this.mock.allowExit) {
        process.exit(exitStatus);
      }
    }
  }

  /**
   * Given a process name, this will report basic
   * OS-level usage statistics like CPU and Memory
   * on a minute-by-minute basis.
   *
   * Returns a function that can be used to stop monitoring.
   */
  resources(procName, interval = 10) {
    if (this._resourceInterval) {
      clearInterval(this._resourceInterval);
    }
    let lastCpuUsage = null;
    let lastMemoryUsage = null;

    this._resourceInterval = setInterval(() => {
      lastCpuUsage = process.cpuUsage(lastCpuUsage);
      lastMemoryUsage = process.memoryUsage(lastMemoryUsage);

      this.measure('process.' + procName + '.cpu', _.sum(Object.values(lastCpuUsage)));
      this.measure('process.' + procName + '.cpu.user', lastCpuUsage.user);
      this.measure('process.' + procName + '.cpu.system', lastCpuUsage.system);
      this.measure('process.' + procName + '.mem', lastMemoryUsage.rss);
    }, interval * 1000);

    return () => this.stopResourceMonitoring();
  }

  stopResourceMonitoring() {
    if (this._resourceInterval) {
      clearInterval(this._resourceInterval);
      this._resourceInterval = null;
    }
  }

  /*
   * TODO
   */
  count(key, val) {
    val = val || 1;
    try {
      assert(typeof val === 'number', 'Count values must be numbers');
    } catch (err) {
      this.log.error('count.invalid', {key, val});
      return;
    }
    this.log.info(key, {val, ...this.metadata});
  }

  /*
   * TODO
   */
  measure(key, val) {
    try {
      assert(typeof val === 'number', 'Measure values must be numbers');
    } catch (err) {
      this.log.error('measure.invalid', {key, val});
      return;
    }
    this.log.info(key, {val, ...this.metadata});
  }

  /*
   * TODO
   */
  logger() {
    return this.log;
  }

  /**
   * TODO
   */
  reportError(err) {
    this.log.error('error', {
      error: err.toString(),
      stack: err.stack,
      ...this.metadata,
    });
  }

  /**
   * TODO
   */
  prefix(pre, metadata = {}) {
    return new Monitor({
      projectName: this.projectName,
      patchGlobal: false, // Handled by root
      bailOnUnhandledRejection: false, // Handled by root
      mock: this.mock,
      enable: this.enable,
      processName: null, // Handled by root
      level: this.level,
      subject: `${this.subject}.${pre}`,
      metadata: Object.assign({}, this.metadata, metadata),
    });
  }

}

module.exports = Monitor;
