const path = require('path');
const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const _ = require('lodash');
const yaml = require('js-yaml');
const depcheck = require('depcheck');

const ROOT_DIR = path.join(__dirname, '..');

describe('Repo Meta Tests', () => {

  test('All packages in CI', async () => {
    const tcconf = path.join(ROOT_DIR, '.taskcluster.yml');
    const tcyml = yaml.safeLoad(fs.readFileSync(tcconf, 'utf8'));
    const configured = tcyml.tasks['$let'].packages;

    const {stdout, stderr} = await exec('yarn workspaces info -s');
    const existing = Object.keys(JSON.parse(stdout));

    const extra = _.difference(configured, existing);
    const missing = _.difference(existing, configured);

    const warning = 'CI configuration in .taskcluster.yml is misconfigured.';
    expect(missing, `${warning} Missing: ${JSON.stringify(missing)}`).toEqual([]);
    expect(extra, `${warning} Remove: ${JSON.stringify(extra)}`).toEqual([]);
  });

  test('Dependencies are not missing/unused', async () => {
    const depOptions = {
      ignoreMatches: [
        'morgan', // Peer dependency of morgan-debug
      ],
    };
    const root = await depcheck(ROOT_DIR, depOptions);
    expect(root.missing, `Missing root deps: ${JSON.stringify(root.missing)}`).toEqual({});

    const rootPkg = require(path.join(ROOT_DIR, 'package.json'));
    const rootDeps = (Object.keys(rootPkg.dependencies || {})).concat((Object.keys(rootPkg.devDependencies || {})));

    const {stdout, stderr} = await exec('yarn workspaces info -s');
    const packages = Object.values(JSON.parse(stdout)).map(p => p.location);
    const unused = {};
    const missing = {};
    await Promise.all(packages.map(async pkg => {
      const leaf = await depcheck(path.join(ROOT_DIR, pkg), depOptions);
      if (leaf.dependencies.length !== 0) {
        unused[pkg] = leaf.dependencies;
      }

      // Note that this will be not take into account whether it will be in production or not
      const missed = _.difference(Object.keys(leaf.missing), rootDeps);
      if (missed.length !== 0) {
        missing[pkg] = _.pick(leaf.missing, missed);
      }
    }));

    expect(unused, `Unused dependencies: ${JSON.stringify(unused, null, 2)}`).toEqual({});
    expect(missing, `Missing dependencies: ${JSON.stringify(missing, null, 2)}`).toEqual({});
  }, 20000);

});
