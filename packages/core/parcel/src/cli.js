// @flow

import type {InitialParcelOptions} from '@parcel/types';
import {BuildError} from '@parcel/core';
import {NodeFS} from '@parcel/fs';
import ThrowableDiagnostic from '@parcel/diagnostic';
import {prettyDiagnostic, openInBrowser} from '@parcel/utils';
import {Disposable} from '@parcel/events';
import {INTERNAL_ORIGINAL_CONSOLE} from '@parcel/logger';
import chalk from 'chalk';
import commander from 'commander';
import path from 'path';
import getPort from 'get-port';
import {version} from '../package.json';
import {DEFAULT_FEATURE_FLAGS} from '@parcel/feature-flags';

const program = new commander.Command();

// Exit codes in response to signals are traditionally
// 128 + signal value
// https://tldp.org/LDP/abs/html/exitcodes.html
const SIGINT_EXIT_CODE = 130;

async function logUncaughtError(e: mixed) {
  if (e instanceof ThrowableDiagnostic) {
    for (let diagnostic of e.diagnostics) {
      let {message, codeframe, stack, hints, documentation} =
        await prettyDiagnostic(diagnostic);
      INTERNAL_ORIGINAL_CONSOLE.error(chalk.red(message));
      if (codeframe || stack) {
        INTERNAL_ORIGINAL_CONSOLE.error('');
      }
      INTERNAL_ORIGINAL_CONSOLE.error(codeframe);
      INTERNAL_ORIGINAL_CONSOLE.error(stack);
      if ((stack || codeframe) && hints.length > 0) {
        INTERNAL_ORIGINAL_CONSOLE.error('');
      }
      for (let h of hints) {
        INTERNAL_ORIGINAL_CONSOLE.error(chalk.blue(h));
      }
      if (documentation) {
        INTERNAL_ORIGINAL_CONSOLE.error(chalk.magenta.bold(documentation));
      }
    }
  } else {
    INTERNAL_ORIGINAL_CONSOLE.error(e);
  }

  // A hack to definitely ensure we logged the uncaught exception
  await new Promise(resolve => setTimeout(resolve, 100));
}

const handleUncaughtException = async exception => {
  try {
    await logUncaughtError(exception);
  } catch (err) {
    console.error(exception);
    console.error(err);
  }

  process.exit(1);
};

process.on('unhandledRejection', handleUncaughtException);

program.storeOptionsAsProperties();
program.version(version);

// Only display choices available to callers OS
let watcherBackendChoices = ['brute-force'];
switch (process.platform) {
  case 'darwin': {
    watcherBackendChoices.push('watchman', 'fs-events');
    break;
  }
  case 'linux': {
    watcherBackendChoices.push('watchman', 'inotify');
    break;
  }
  case 'win32': {
    watcherBackendChoices.push('watchman', 'windows');
    break;
  }
  case 'freebsd' || 'openbsd': {
    watcherBackendChoices.push('watchman');
    break;
  }
  default:
    break;
}

// --no-cache, --cache-dir, --no-source-maps, --no-autoinstall, --global?, --public-url, --log-level
// --no-content-hash, --experimental-scope-hoisting, --detailed-report
const commonOptions = {
  '--no-cache': 'disable the filesystem cache',
  '--config <path>':
    'specify which config to use. can be a path or a package name',
  '--cache-dir <path>': 'set the cache directory. defaults to ".parcel-cache"',
  '--watch-dir <path>':
    'set the root watch directory. defaults to nearest lockfile or source control dir.',
  '--watch-ignore [path]': [
    `list of directories watcher should not be tracking for changes. defaults to ['.git', '.hg']`,
    dirs => dirs.split(','),
  ],
  '--watch-backend': new commander.Option(
    '--watch-backend <name>',
    'set watcher backend',
  ).choices(watcherBackendChoices),
  '--no-source-maps': 'disable sourcemaps',
  '--target [name]': [
    'only build given target(s)',
    (val, list) => list.concat([val]),
    [],
  ],
  '--log-level <level>': new commander.Option(
    '--log-level <level>',
    'set the log level',
  ).choices(['none', 'error', 'warn', 'info', 'verbose']),
  '--dist-dir <dir>':
    'output directory to write to when unspecified by targets',
  '--no-autoinstall': 'disable autoinstall',
  '--profile': 'enable sampling build profiling',
  '--trace': 'enable build tracing',
  '-V, --version': 'output the version number',
  '--detailed-report [count]': [
    'print the asset timings and sizes in the build report',
    parseOptionInt,
  ],
  '--reporter <name>': [
    'additional reporters to run',
    (val, acc) => {
      acc.push(val);
      return acc;
    },
    [],
  ],
  '--feature-flag <name=value>': [
    'sets the value of a feature flag',
    (value, previousValue) => {
      let [name, val] = value.split('=');
      if (name in DEFAULT_FEATURE_FLAGS) {
        let featureFlagValue;
        if (typeof DEFAULT_FEATURE_FLAGS[name] === 'boolean') {
          if (val !== 'true' && val !== 'false') {
            throw new Error(
              `Feature flag ${name} must be set to true or false`,
            );
          }
          featureFlagValue = val === 'true';
        }
        previousValue[name] = featureFlagValue ?? String(val);
      } else {
        INTERNAL_ORIGINAL_CONSOLE.warn(
          `Unknown feature flag ${name} specified, it will be ignored`,
        );
      }
      return previousValue;
    },
    {},
  ],
};

var hmrOptions = {
  '--no-hmr': 'disable hot module replacement',
  '-p, --port <port>': [
    'set the port to serve on. defaults to $PORT or 1234',
    process.env.PORT,
  ],
  '--host <host>':
    'set the host to listen on, defaults to listening on all interfaces',
  '--https': 'serves files over HTTPS',
  '--cert <path>': 'path to certificate to use with HTTPS',
  '--key <path>': 'path to private key to use with HTTPS',
  '--hmr-port <port>': ['hot module replacement port', process.env.HMR_PORT],
  '--hmr-host <host>': ['hot module replacement host', process.env.HMR_HOST],
};

function applyOptions(cmd, options) {
  for (let opt in options) {
    const option = options[opt];
    if (option instanceof commander.Option) {
      cmd.addOption(option);
    } else {
      cmd.option(opt, ...(Array.isArray(option) ? option : [option]));
    }
  }
}

let serve = program
  .command('serve [input...]')
  .description('starts a development server')
  .option('--public-url <url>', 'the path prefix for absolute urls')
  .option(
    '--open [browser]',
    'automatically open in specified browser, defaults to default browser',
  )
  .option('--watch-for-stdin', 'exit when stdin closes')
  .option(
    '--lazy [includes]',
    'Build async bundles on demand, when requested in the browser. Defaults to all async bundles, unless a comma separated list of source file globs is provided. Only async bundles whose entry points match these globs will be built lazily',
  )
  .option(
    '--lazy-exclude <excludes>',
    'Can only be used in combination with --lazy. Comma separated list of source file globs, async bundles whose entry points match these globs will not be built lazily',
  )
  .action(runCommand);

applyOptions(serve, hmrOptions);
applyOptions(serve, commonOptions);

let watch = program
  .command('watch [input...]')
  .description('starts the bundler in watch mode')
  .option('--public-url <url>', 'the path prefix for absolute urls')
  .option('--no-content-hash', 'disable content hashing')
  .option('--watch-for-stdin', 'exit when stdin closes')
  .action(runCommand);

applyOptions(watch, hmrOptions);
applyOptions(watch, commonOptions);

let build = program
  .command('build [input...]')
  .description('bundles for production')
  .option('--no-optimize', 'disable minification')
  .option('--no-scope-hoist', 'disable scope-hoisting')
  .option('--public-url <url>', 'the path prefix for absolute urls')
  .option('--no-content-hash', 'disable content hashing')
  .action(runCommand);

applyOptions(build, commonOptions);

program
  .command('help [command]')
  .description('display help information for a command')
  .action(function (command) {
    let cmd = program.commands.find(c => c.name() === command) || program;
    cmd.help();
  });

program.on('--help', function () {
  INTERNAL_ORIGINAL_CONSOLE.log('');
  INTERNAL_ORIGINAL_CONSOLE.log(
    '  Run `' +
      chalk.bold('parcel help <command>') +
      '` for more information on specific commands',
  );
  INTERNAL_ORIGINAL_CONSOLE.log('');
});

// Override to output option description if argument was missing
// $FlowFixMe[prop-missing]
commander.Command.prototype.optionMissingArgument = function (option) {
  INTERNAL_ORIGINAL_CONSOLE.error(
    "error: option `%s' argument missing",
    option.flags,
  );
  INTERNAL_ORIGINAL_CONSOLE.log(program.createHelp().optionDescription(option));
  process.exit(1);
};

// Make serve the default command except for --help
var args = process.argv;
if (args[2] === '--help' || args[2] === '-h') args[2] = 'help';

if (!args[2] || !program.commands.some(c => c.name() === args[2])) {
  args.splice(2, 0, 'serve');
}

program.parse(args);

function runCommand(...args) {
  run(...args).catch(handleUncaughtException);
}

async function run(
  entries: Array<string>,
  _opts: any, // using pre v7 Commander options as properties
  command: any,
) {
  if (entries.length === 0) {
    entries = ['.'];
  }

  entries = entries.map(entry => path.resolve(entry));

  let Parcel = require('@parcel/core').default;
  let fs = new NodeFS();
  let options = await normalizeOptions(command, fs);
  let parcel = new Parcel({
    entries,
    defaultConfig: require.resolve('@parcel/config-default', {
      paths: [fs.cwd(), __dirname],
    }),
    shouldPatchConsole: false,
    ...options,
  });

  let disposable = new Disposable();
  let unsubscribe: () => Promise<mixed>;
  let isExiting;
  async function exit(exitCode: number = 0) {
    if (isExiting) {
      return;
    }

    isExiting = true;
    if (unsubscribe != null) {
      await unsubscribe();
    } else if (parcel.isProfiling) {
      await parcel.stopProfiling();
    }

    if (process.stdin.isTTY && process.stdin.isRaw) {
      // $FlowFixMe
      process.stdin.setRawMode(false);
    }

    disposable.dispose();
    process.exit(exitCode);
  }

  const isWatching = command.name() === 'watch' || command.name() === 'serve';
  if (process.stdin.isTTY) {
    // $FlowFixMe
    process.stdin.setRawMode(true);
    require('readline').emitKeypressEvents(process.stdin);

    let stream = process.stdin.on('keypress', async (char, key) => {
      if (!key.ctrl) {
        return;
      }

      switch (key.name) {
        case 'c':
          // Detect the ctrl+c key, and gracefully exit after writing the asset graph to the cache.
          // This is mostly for tools that wrap Parcel as a child process like yarn and npm.
          //
          // Setting raw mode prevents SIGINT from being sent in response to ctrl-c:
          // https://nodejs.org/api/tty.html#tty_readstream_setrawmode_mode
          //
          // We don't use the SIGINT event for this because when run inside yarn, the parent
          // yarn process ends before Parcel and it appears that Parcel has ended while it may still
          // be cleaning up. Handling events from stdin prevents this impression.
          //
          // When watching, a 0 success code is acceptable when Parcel is interrupted with ctrl-c.
          // When building, fail with a code as if we received a SIGINT.
          await exit(isWatching ? 0 : SIGINT_EXIT_CODE);
          break;
        case 'e':
          await (parcel.isProfiling
            ? parcel.stopProfiling()
            : parcel.startProfiling());
          break;
        case 'y':
          await parcel.takeHeapSnapshot();
          break;
      }
    });

    disposable.add(() => {
      stream.destroy();
    });
  }

  if (isWatching) {
    ({unsubscribe} = await parcel.watch(err => {
      if (err) {
        throw err;
      }
    }));

    if (command.open && options.serveOptions) {
      await openInBrowser(
        `${options.serveOptions.https ? 'https' : 'http'}://${
          options.serveOptions.host || 'localhost'
        }:${options.serveOptions.port}`,
        command.open,
      );
    }

    if (command.watchForStdin) {
      process.stdin.on('end', async () => {
        INTERNAL_ORIGINAL_CONSOLE.log('STDIN closed, ending');

        await exit();
      });
      process.stdin.resume();
    }

    // In non-tty cases, respond to SIGINT by cleaning up. Since we're watching,
    // a 0 success code is acceptable.
    process.on('SIGINT', () => exit());
    process.on('SIGTERM', () => exit());
  } else {
    try {
      await parcel.run();
    } catch (err) {
      // If an exception is thrown during Parcel.build, it is given to reporters in a
      // buildFailure event, and has been shown to the user.
      if (!(err instanceof BuildError)) {
        await logUncaughtError(err);
      }
      await exit(1);
    }

    await exit();
  }
}

function parsePort(portValue: string): number {
  let parsedPort = Number(portValue);

  // Throw an error if port value is invalid...
  if (!Number.isInteger(parsedPort)) {
    throw new Error(`Port ${portValue} is not a valid integer.`);
  }

  return parsedPort;
}

function parseOptionInt(value) {
  const parsedValue = parseInt(value, 10);
  if (isNaN(parsedValue)) {
    throw new commander.InvalidOptionArgumentError('Must be an integer.');
  }
  return parsedValue;
}

async function normalizeOptions(
  command,
  inputFS,
): Promise<InitialParcelOptions> {
  let nodeEnv;
  if (command.name() === 'build') {
    nodeEnv = process.env.NODE_ENV || 'production';
    // Autoinstall unless explicitly disabled or we detect a CI environment.
    command.autoinstall = !(command.autoinstall === false || process.env.CI);
  } else {
    nodeEnv = process.env.NODE_ENV || 'development';
  }

  // Set process.env.NODE_ENV to a default if undefined so that it is
  // available in JS configs and plugins.
  process.env.NODE_ENV = nodeEnv;

  let https = !!command.https;
  if (command.cert && command.key) {
    https = {
      cert: command.cert,
      key: command.key,
    };
  }

  let serveOptions = false;
  let {host} = command;

  // Ensure port is valid and available
  let port = parsePort(command.port || '1234');
  let originalPort = port;
  if (command.name() === 'serve' || command.hmr) {
    try {
      port = await getPort({port, host});
    } catch (err) {
      throw new ThrowableDiagnostic({
        diagnostic: {
          message: `Could not get available port: ${err.message}`,
          origin: 'parcel',
          stack: err.stack,
        },
      });
    }

    if (port !== originalPort) {
      let errorMessage = `Port "${originalPort}" could not be used`;
      if (command.port != null) {
        // Throw the error if the user defined a custom port
        throw new Error(errorMessage);
      } else {
        // Parcel logger is not set up at this point, so just use native INTERNAL_ORIGINAL_CONSOLE
        INTERNAL_ORIGINAL_CONSOLE.warn(errorMessage);
      }
    }
  }

  if (command.name() === 'serve') {
    let {publicUrl} = command;

    serveOptions = {
      https,
      port,
      host,
      publicUrl,
    };
  }

  let hmrOptions = null;
  if (command.name() !== 'build' && command.hmr !== false) {
    let hmrport = command.hmrPort ? parsePort(command.hmrPort) : port;
    let hmrhost = command.hmrHost ? command.hmrHost : host;

    hmrOptions = {
      port: hmrport,
      host: hmrhost,
    };
  }

  if (command.detailedReport === true) {
    command.detailedReport = '10';
  }

  let additionalReporters = [
    {packageName: '@parcel/reporter-cli', resolveFrom: __filename},
    ...(command.reporter: Array<string>).map(packageName => ({
      packageName,
      resolveFrom: path.join(inputFS.cwd(), 'index'),
    })),
  ];

  if (command.trace) {
    additionalReporters.unshift({
      packageName: '@parcel/reporter-tracer',
      resolveFrom: __filename,
    });
  }

  let mode = command.name() === 'build' ? 'production' : 'development';

  const normalizeIncludeExcludeList = (input?: string): string[] => {
    if (typeof input !== 'string') return [];
    return input.split(',').map(value => value.trim());
  };

  return {
    shouldDisableCache: command.cache === false,
    cacheDir: command.cacheDir,
    watchDir: command.watchDir,
    watchBackend: command.watchBackend,
    watchIgnore: command.watchIgnore,
    config: command.config,
    mode,
    hmrOptions,
    shouldContentHash: hmrOptions ? false : command.contentHash,
    serveOptions,
    targets: command.target.length > 0 ? command.target : null,
    shouldAutoInstall: command.autoinstall ?? true,
    logLevel: command.logLevel,
    shouldProfile: command.profile,
    shouldTrace: command.trace,
    shouldBuildLazily: typeof command.lazy !== 'undefined',
    lazyIncludes: normalizeIncludeExcludeList(command.lazy),
    lazyExcludes: normalizeIncludeExcludeList(command.lazyExclude),
    shouldBundleIncrementally:
      process.env.PARCEL_INCREMENTAL_BUNDLING === 'false' ? false : true,
    detailedReport:
      command.detailedReport != null
        ? {
            assetsPerBundle: parseInt(command.detailedReport, 10),
          }
        : null,
    env: {
      NODE_ENV: nodeEnv,
    },
    additionalReporters,
    defaultTargetOptions: {
      shouldOptimize:
        command.optimize != null ? command.optimize : mode === 'production',
      sourceMaps: command.sourceMaps ?? true,
      shouldScopeHoist: command.scopeHoist,
      publicUrl: command.publicUrl,
      distDir: command.distDir,
    },
    featureFlags: command.featureFlag,
  };
}
