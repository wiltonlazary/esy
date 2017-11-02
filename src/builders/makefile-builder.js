/**
 * @flow
 */

import type {BuildSpec, BuildTask, Config, BuildSandbox} from '../types';

import {sync as mkdirp} from 'mkdirp';
import createLogger from 'debug';
import outdent from 'outdent';

import * as Graph from '../graph';
import * as Task from '../build-task';
import * as Env from '../environment';
import * as Makefile from '../Makefile';
import {normalizePackageName} from '../util';
import {renderEnv, renderSandboxSbConfig} from './util';
import {singleQuote} from '../lib/shell';
import * as fs from '../lib/fs';
import * as path from '../lib/path';
import * as bashgen from './bashgen';
import * as constants from '../constants';

const log = createLogger('esy:makefile-builder');
const CWD = process.cwd();

function createRenderEnvRule(params: {target: string, input: string}) {
  return Makefile.createRule({
    target: params.target,
    dependencies: [params.input, initRootRule.target],
    shell: '/bin/bash',
    command: `@$(shell_env_sandbox) ${bin.renderEnv} $(<) $(@)`,
  });
}

function createMkdirRule(params: {target: string}) {
  return Makefile.createRule({
    target: params.target,
    command: `@mkdir -p $(@)`,
  });
}

const bin = {
  renderEnv: ejectedRootPath('bin', 'render-env'),
  getStorePath: ejectedRootPath('bin', 'get-store-path'),
  realpath: ejectedRootPath('bin', 'realpath'),
  realpathSource: ejectedRootPath('bin', 'realpath.c'),
  fastreplacestring: ejectedRootPath('bin', 'fastreplacestring.exe'),
  fastreplacestringSource: ejectedRootPath('bin', 'fastreplacestring.cpp'),
  runtime: ejectedRootPath('bin', 'runtime.sh'),
};

const files = {
  commandEnv: {
    filename: ['bin/render-env'],
    executable: true,
    contents: outdent`
      #!/bin/bash

      set -e
      set -o pipefail

      _TMPDIR_GLOBAL=$($ESY_EJECT__ROOT/bin/realpath "/tmp")

      if [ -d "$TMPDIR" ]; then
        _TMPDIR=$($ESY_EJECT__ROOT/bin/realpath "$TMPDIR")
      else
        _TMPDIR="/does/not/exist"
      fi

      sed \\
        -e "s|\\$ESY_EJECT__STORE|$ESY_EJECT__STORE|g"          \\
        -e "s|\\$ESY_EJECT__SANDBOX|$ESY_EJECT__SANDBOX|g"      \\
        -e "s|\\$ESY_EJECT__ROOT|$ESY_EJECT__ROOT|g"      \\
        -e "s|\\$TMPDIR_GLOBAL|$_TMPDIR_GLOBAL|g"   \\
        -e "s|\\$TMPDIR|$_TMPDIR|g"                 \\
        $1 > $2
    `,
  },

  getStorePath: {
    filename: ['bin/get-store-path'],
    executable: true,
    contents: outdent`
      #!/bin/bash

      set -e
      set -o pipefail

      ${bashgen.defineEsyUtil}

      esyGetStorePathFromPrefix "$1"
    `,
  },

  fastreplacestringSource: {
    filename: ['bin', 'fastreplacestring.cpp'],
    contents: fs.readFileSync(require.resolve('fastreplacestring/fastreplacestring.cpp')),
  },

  realpathSource: {
    filename: ['bin', 'realpath.c'],
    contents: outdent`
      #include<stdlib.h>

      main(int cc, char**vargs) {
        puts(realpath(vargs[1], 0));
        exit(0);
      }
    `,
  },

  runtimeSource: {
    filename: ['bin', 'runtime.sh'],
    contents: fs.readFileSync(require.resolve('./makefile-builder-runtime.sh')),
  },
};

const preludeRuleSet = [
  Makefile.createRaw('SHELL := env -i /bin/bash --norc --noprofile'),

  // ESY_EJECT__ROOT is the root directory of the ejected Esy build
  // environment.
  Makefile.createRaw(
    'ESY_EJECT__ROOT := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))',
  ),

  // ESY_EJECT__PREFIX is the directory where esy keeps the store and other
  // artefacts
  Makefile.createRaw('ESY_EJECT__PREFIX ?= $(HOME)/.esy'),

  Makefile.createRaw(
    `ESY_EJECT__STORE = $(shell ${bin.getStorePath} $(ESY_EJECT__PREFIX))`,
  ),

  // ESY_EJECT__SANDBOX is the sandbox directory, the directory where the root
  // package resides.
  Makefile.createRaw('ESY_EJECT__SANDBOX ?= $(CURDIR)'),
];

const compileRealpathRule = Makefile.createRule({
  target: bin.realpath,
  dependencies: [bin.realpathSource],
  shell: '/bin/bash',
  command: '@gcc -o $(@) -x c $(<) 2> /dev/null',
});

const compileFastreplacestringRule = Makefile.createRule({
  target: bin.fastreplacestring,
  dependencies: [bin.fastreplacestringSource],
  shell: '/bin/bash',
  command: '@g++ -Ofast -o $(@) $(<) 2> /dev/null',
});

const initStoreRule = Makefile.createRule({
  target: 'esy-store',
  phony: true,
  dependencies: [
    createMkdirRule({target: storePath(constants.STORE_BUILD_TREE)}),
    createMkdirRule({target: storePath(constants.STORE_INSTALL_TREE)}),
    createMkdirRule({target: storePath(constants.STORE_STAGE_TREE)}),
    createMkdirRule({target: localStorePath(constants.STORE_BUILD_TREE)}),
    createMkdirRule({target: localStorePath(constants.STORE_INSTALL_TREE)}),
    createMkdirRule({target: localStorePath(constants.STORE_STAGE_TREE)}),
  ],
});

const initRootRule = Makefile.createRule({
  target: 'esy-root',
  phony: true,
  dependencies: [compileRealpathRule, compileFastreplacestringRule],
});

const defineSandboxEnvRule = Makefile.createDefine({
  name: `shell_env_sandbox`,
  value: [
    {
      CI: process.env.CI ? process.env.CI : null,
      TMPDIR: '$(TMPDIR)',
      ESY_EJECT__PREFIX: '$(ESY_EJECT__PREFIX)',
      ESY_EJECT__STORE: storePath(),
      ESY_EJECT__SANDBOX: sandboxPath(),
      ESY_EJECT__ROOT: ejectedRootPath(),
    },
  ],
});

/**
 * Render `build` as Makefile (+ related files) into the supplied `outputPath`.
 */
export function eject(
  sandbox: BuildSandbox,
  outputPath: string,
  config: Config<path.Path>,
) {
  const buildFiles = [];
  const finalInstallPathSet = [];

  function generateMetaRule({filename, contents}) {
    const input = ejectedRootPath('records', `${filename}.in`);
    const target = ejectedRootPath('records', filename);
    const rule = createRenderEnvRule({target, input});

    buildFiles.push({
      filename: ['records', `${filename}.in`],
      contents: contents + '\n',
    });

    return rule;
  }

  function createBuildRule(
    build: BuildSpec,
    rule: {
      target: string,
      command: string,
      withBuildEnv?: boolean,
      dependencies: Array<Makefile.MakefileItemDependency>,
    },
  ): Makefile.MakefileItem {
    const packageName = normalizePackageName(build.id);
    const command = [];
    if (rule.withBuildEnv) {
      command.push(outdent`
        @$(shell_env_for__${packageName}) source ${bin.runtime}
        cd $esy_build__source_root
      `);
    }
    command.push(rule.command);

    const target = `${rule.target}.${build.sourcePath === ''
      ? 'sandbox'
      : `sandbox/${build.sourcePath}`}`;

    return Makefile.createRule({
      target,
      dependencies: [bootstrapRule, ...rule.dependencies],
      phony: true,
      command,
    });
  }

  function createBuildRules(directDependencies, allDependencies, task: BuildTask) {
    log(`visit ${task.spec.id}`);

    const packageName = normalizePackageName(task.spec.id);
    const packagePath = task.spec.sourcePath.split(path.sep).filter(Boolean);

    const finalInstallPath = config.getFinalInstallPath(task.spec);

    // Emit env
    buildFiles.push({
      filename: packagePath.concat('eject-env'),
      contents: renderEnv(task.env),
    });

    // Generate macOS sandbox configuration (sandbox-exec command)
    buildFiles.push({
      filename: packagePath.concat('sandbox.sb.in'),
      contents: renderSandboxSbConfig(task.spec, config, {
        allowFileWrite: ['$TMPDIR', '$TMPDIR_GLOBAL'],
      }),
    });

    const envRule = Makefile.createDefine({
      name: `shell_env_for__${normalizePackageName(task.spec.id)}`,
      value: [
        {
          CI: process.env.CI ? process.env.CI : null,
          TMPDIR: '$(TMPDIR)',
          ESY_EJECT__STORE: storePath(),
          ESY_EJECT__SANDBOX: sandboxPath(),
          ESY_EJECT__ROOT: ejectedRootPath(),
        },
        `source ${ejectedRootPath(...packagePath, 'eject-env')}`,
        {
          esy_build__eject: ejectedRootPath(...packagePath),
          esy_build__type: task.spec.buildType,
          esy_build__source_type: task.spec.sourceType,
          esy_build__key: task.id,
          esy_build__command: renderBuildTaskCommand(task) || 'true',
          esy_build__source_root: path.join(config.sandboxPath, task.spec.sourcePath),
          esy_build__install: finalInstallPath,
        },
      ],
    });

    const buildDependenciesRule = [];
    const cleanDependenciesRule = [];

    for (const depRules of directDependencies.values()) {
      buildDependenciesRule.push(depRules.buildRule);
      cleanDependenciesRule.push(depRules.cleanRule);
    }

    const rules = [];
    for (const depRules of allDependencies.values()) {
      rules.push(depRules.buildShellRule);
    }

    const sandboxConfigRule = createRenderEnvRule({
      target: ejectedRootPath(...packagePath, 'sandbox.sb'),
      input: ejectedRootPath(...packagePath, 'sandbox.sb.in'),
    });

    const buildRule = createBuildRule(task.spec, {
      target: 'build',
      command: 'esy-build',
      withBuildEnv: true,
      dependencies: [envRule, sandboxConfigRule, ...buildDependenciesRule],
    });

    const buildShellRule = createBuildRule(task.spec, {
      target: 'shell',
      command: 'esy-shell',
      withBuildEnv: true,
      dependencies: [envRule, sandboxConfigRule, ...buildDependenciesRule],
    });

    const cleanRule = createBuildRule(task.spec, {
      target: 'clean',
      command: outdent`
        @rm -f ${sandboxConfigRule.target}
      `,
      dependencies: [...cleanDependenciesRule],
    });

    finalInstallPathSet.push(finalInstallPath);

    return {
      buildRule,
      buildShellRule,
      cleanRule,
      rules: Makefile.createGroup(...rules),
    };
  }

  log(`eject build environment into <ejectRootDir>=./${path.relative(CWD, outputPath)}`);

  // Emit build artefacts for packages
  log('process dependency graph');
  const rootTask = Task.fromBuildSandbox(sandbox, config);

  const finalInstallPathSetMetaRule = generateMetaRule({
    filename: 'final-install-path-set.txt',
    contents: finalInstallPathSet.join('\n'),
  });

  const storePathMetaRule = generateMetaRule({
    filename: 'store-path.txt',
    contents: '$ESY_EJECT__STORE',
  });

  const bootstrapRule = Makefile.createRule({
    target: 'bootstrap',
    phony: true,
    dependencies: [
      finalInstallPathSetMetaRule,
      storePathMetaRule,
      defineSandboxEnvRule,
      initRootRule,
      initStoreRule,
    ],
  });

  const {
    buildRule: rootBuildRule,
    buildShellRule: rootBuildShellRule,
    cleanRule: rootCleanRule,
    rules,
  } = Graph.topologicalFold(rootTask, createBuildRules);

  const buildRule = Makefile.createRule({
    target: 'build',
    phony: true,
    dependencies: [rootBuildRule],
  });

  const buildShellRule = Makefile.createRule({
    target: 'build-shell',
    phony: true,
    dependencies: [rootBuildShellRule],
  });

  const cleanRule = Makefile.createRule({
    target: 'clean',
    phony: true,
    command: outdent`
      rm -f ${sandboxPath(constants.BUILD_TREE_SYMLINK)}
      rm -f ${sandboxPath(constants.INSTALL_TREE_SYMLINK)}
    `,
  });

  const makefileFile = {
    filename: ['Makefile'],
    contents: Makefile.renderMakefile([
      ...preludeRuleSet,
      buildRule,
      buildShellRule,
      cleanRule,
      rules,
    ]),
  };

  const commandEnvFile = createCommandEnvFile(sandbox, config);

  log('build environment');
  Promise.all([
    ...buildFiles.map(file => emitFile(outputPath, file)),
    emitFile(outputPath, files.commandEnv),
    emitFile(outputPath, files.getStorePath),
    emitFile(outputPath, files.fastreplacestringSource),
    emitFile(outputPath, files.realpathSource),
    emitFile(outputPath, files.runtimeSource),
    emitFile(outputPath, commandEnvFile),
    emitFile(outputPath, makefileFile),
  ]);
}

function createCommandEnvFile(sandbox, config) {
  const task = Task.fromBuildSandbox(sandbox, config, {
    exposeOwnPath: true,
  });
  task.env.delete('SHELL');
  return {
    filename: ['command-env'],
    contents: outdent`
      ${bashgen.defineEsyUtil}

      # Set the default value for ESY_EJECT__STORE if it's not defined.
      if [ -z \${ESY_EJECT__STORE+x} ]; then
        export ESY_EJECT__STORE=$(esyGetStorePathFromPrefix "$HOME/.esy")
      fi

      ${Env.printEnvironment(task.env)}
    `,
  };
}

async function emitFile(
  outputPath: string,
  file: {filename: Array<string>, contents: string, executable?: boolean},
) {
  const filename = path.join(outputPath, ...file.filename);
  log(`emit <ejectRootDir>/${file.filename.join('/')}`);
  await fs.mkdirp(path.dirname(filename));
  await fs.writeFile(filename, file.contents);
  if (file.executable) {
    // fs.constants only became supported in node 6.7 or so.
    const mode = fs.constants && fs.constants.S_IRWXU ? fs.constants.S_IRWXU : 448;
    await fs.chmod(filename, mode);
  }
}

function renderBuildTaskCommand(task: BuildTask) {
  if (task.command == null) {
    return null;
  }
  const command = task.command.map(c => c.renderedCommand).join(' && ');
  return Makefile.quoted(singleQuote(command));
}

function ejectedRootPath(...segments) {
  return path.join('$(ESY_EJECT__ROOT)', ...segments);
}

function sandboxPath(...segments) {
  return path.join('$(ESY_EJECT__SANDBOX)', ...segments);
}

function storePath(...segments) {
  return path.join('$(ESY_EJECT__STORE)', ...segments);
}

function localStorePath(...segments) {
  return sandboxPath('node_modules', '.cache', '_esy', 'store', ...segments);
}
