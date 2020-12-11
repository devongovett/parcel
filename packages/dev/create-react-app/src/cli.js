// @flow strict-local

import program from 'commander';
// flowlint-next-line untyped-import:off
import {name, version} from '../package.json';
// flowlint-next-line untyped-import:off
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';
import _ncp from 'ncp';
import {promisify} from 'util';
import commandExists from 'command-exists';
// flowlint-next-line untyped-import:off
import _spawn from '@npmcli/promise-spawn';
import _rimraf from 'rimraf';
import tempy from 'tempy';
import chalk from 'chalk';
import * as emoji from './emoji';

const TEMPLATES_DIR = path.resolve(__dirname, '../templates');

const ncp = promisify(_ncp);
const rimraf = promisify(_rimraf);
// eslint-disable-next-line no-console
const log = console.log;

// flowlint-next-line untyped-import:off
require('v8-compile-cache');

// $FlowFixMe[incompatible-call]
program.name(name).version(version);
program.action((command: string | typeof program) => {
  if (typeof command !== 'string') {
    command.help();
    return;
  }

  run(command).catch(reason => {
    // eslint-disable-next-line no-console
    console.error(chalk `${emoji.error} {red ${reason.message}}`);
    process.exit(1);
  });
});

program.parse(process.argv);

async function run(packagePath: string) {
  log(chalk `${emoji.progress} {green Creating Parcel app at}`, chalk.bold.underline(packagePath));
  if (await fsExists(packagePath)) {
    throw new Error(chalk `${emoji.error} {red File or directory at {bold.underline ${packagePath}} already exists}`);
  }

  let tempPath = tempy.directory();
  try {
    await createApp(path.basename(packagePath), tempPath);
  } catch (e) {
    await rimraf(tempPath);
    throw e;
  }

  await fs.promises.rename(tempPath, packagePath);

  // Print instructions
  log(chalk `{green ${emoji.success} Successfully created a new Parcel app at {bold.underline ${packagePath}.} }`);
  log(
    chalk `${emoji.info}  {dim Run} {bold.underline \`cd ${packagePath}\`} {dim and then} {bold \`${
      usesYarn ? 'yarn' : 'npm run'
    } start\`} {dim to start developing with Parcel.}`,
  );
}

async function createApp(packageName: string, tempPath: string) {
  log(emoji.progress + ' Creating package directory...');
  const git = simpleGit({baseDir: tempPath});
  log(emoji.progress + ' Initializing git repository...');
  await git.init();

  log(emoji.progress + ' Adding templates...');
  async function writePackageJson() {
    const packageJson = JSON.parse(
      await fs.promises.readFile(
        path.join(TEMPLATES_DIR, 'package.json'),
        'utf8',
      ),
    );
    await fs.promises.writeFile(
      path.join(tempPath, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          ...packageJson,
        },
        null,
        2,
      ),
    );
  }

  await Promise.all([
    writePackageJson(),
    ncp(path.join(TEMPLATES_DIR, 'default'), tempPath),
  ]);

  log(emoji.progress + ' Installing packages...');
  await installPackages(['parcel@nightly'], {
    cwd: tempPath,
    isDevDependency: true,
  });
  await installPackages(['react', 'react-dom'], {cwd: tempPath});

  // Initial commit
  log(chalk.green(emoji.progress + ' Creating initial commit...'));
  await git.add('.');
  await git.commit(chalk.magenta(emoji.info + '  Initial commit created with @parcel/create-react-app'));
}

async function fsExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(filePath)) && true;
  } catch {
    return false;
  }
}

let usesYarn;
async function installPackages(
  packageExpressions: Array<string>,
  opts: {|
    cwd: string,
    isDevDependency?: boolean,
  |},
): Promise<void> {
  log(emoji.progress + chalk `{dim Installing}'`, chalk.bold(...packageExpressions));
  if (usesYarn == null) {
    usesYarn = await commandExists('yarn');
    if (!(await commandExists('npm'))) {
      throw new Error(emoji.error + chalk.red(' Neither npm nor yarn found on system'));
    }
  }

  if (usesYarn) {
    return spawn(
      'yarn',
      [
        'add',
        opts.isDevDependency ? '--dev' : null,
        ...packageExpressions,
      ].filter(Boolean),
      opts.cwd,
    );
  }

  return spawn(
    'npm',
    [
      'install',
      opts.isDevDependency ? '--save-dev' : null,
      ...packageExpressions,
    ].filter(Boolean),
    opts.cwd,
  );
}

function spawn(command: string, args: Array<mixed>, cwd: string) {
  return _spawn(command, args, {
    cwd,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
}
