/* @flow */

const helpers = require('../test/helpers.js');

helpers.skipSuiteOnWindows('Needs investigation');

describe(`Basic tests`, () => {
  test(`it should correctly install a single dependency that contains no sub-dependencies`, async () => {
    const fixture = [
      helpers.packageJson({
        name: 'root',
        version: '1.0.0',
        esy: {},
        dependencies: {[`no-deps`]: `1.0.0`},
      }),
    ];
    const p = await helpers.createTestSandbox(...fixture);

    await p.esy(`install`);

    await expect(
      p.runJavaScriptInNodeAndReturnJson(`require('no-deps')`),
    ).resolves.toMatchObject({
      name: `no-deps`,
      version: `1.0.0`,
    });
  });

  test(`it should correctly install a dependency that itself contains a fixed dependency`, async () => {
    const fixture = [
      helpers.packageJson({
        name: 'root',
        version: '1.0.0',
        esy: {},
        dependencies: {[`one-fixed-dep`]: `1.0.0`},
      }),
    ];
    const p = await helpers.createTestSandbox(...fixture);
    await p.esy(`install`);

    await expect(
      p.runJavaScriptInNodeAndReturnJson(`require('one-fixed-dep')`),
    ).resolves.toMatchObject({
      name: `one-fixed-dep`,
      version: `1.0.0`,
      dependencies: {
        [`no-deps`]: {
          name: `no-deps`,
          version: `1.0.0`,
        },
      },
    });
  });

  test(`it should correctly install a dependency that itself contains a range dependency`, async () => {
    const fixture = [
      helpers.packageJson({
        name: 'root',
        version: '1.0.0',
        esy: {},
        dependencies: {[`one-range-dep`]: `1.0.0`},
      }),
    ];

    const p = await helpers.createTestSandbox(...fixture);
    await p.esy(`install`);

    await expect(
      p.runJavaScriptInNodeAndReturnJson(`require('one-range-dep')`),
    ).resolves.toMatchObject({
      name: `one-range-dep`,
      version: `1.0.0`,
      dependencies: {
        [`no-deps`]: {
          name: `no-deps`,
          version: `1.1.0`,
        },
      },
    });
  });

  test(`it should prefer esy._dependenciesForNewEsyInstaller`, async () => {
    const fixture = [
      helpers.packageJson({
        name: 'root',
        version: '1.0.0',
        dependencies: {apkg: `1.0.0`},
        esy: {},
      }),
    ];

    const p = await helpers.createTestSandbox(...fixture);
    await p.defineNpmPackage({
      name: 'apkg',
      version: '1.0.0',
      esy: {
        _dependenciesForNewEsyInstaller: {
          'apkg-dep': `2.0.0`,
        },
      },
      dependencies: {'apkg-dep': `1.0.0`},
    });
    await p.defineNpmPackage({
      name: 'apkg-dep',
      esy: {},
      version: '1.0.0',
    });
    await p.defineNpmPackage({
      name: 'apkg-dep',
      esy: {},
      version: '2.0.0',
    });

    await p.esy(`install`);

    await expect(
      p.runJavaScriptInNodeAndReturnJson(`require('apkg-dep/package.json')`),
    ).resolves.toMatchObject({
      name: 'apkg-dep',
      version: `2.0.0`,
    });
  });
});
