#!/usr/bin/env node

// @flow
/* eslint-disable no-console */

// $FlowFixMe
import fs from 'fs/promises';
import {readdirSync} from 'fs';
import path from 'path';
import {spawn as _spawn} from 'child_process';
// $FlowFixMe
import {parseArgs, styleText} from 'util';

const supportsEmoji = isUnicodeSupported();

// Fallback symbols for Windows from https://en.wikipedia.org/wiki/Code_page_437
const success: string = supportsEmoji ? '✨' : '√';
const error: string = supportsEmoji ? '🚨' : '×';

const {positionals} = parseArgs({
  allowPositionals: true,
  options: {},
});

let template = positionals[0];
if (!template) {
  let packageManager = getCurrentPackageManager()?.name;
  console.error(
    `Usage: ${packageManager ?? 'npm'} create <template> [directory]\n`,
  );
  printAvailableTemplates();
  console.log('');
  process.exit(1);
}

let name = positionals[1];
if (!name) {
  name = '.';
}

install(template, name).then(
  () => {
    process.exit(0);
  },
  err => {
    console.error(err);
    process.exit(1);
  },
);

async function install(template: string, name: string) {
  let templateDir = path.join(__dirname, '..', 'templates', template);
  try {
    await fs.stat(templateDir);
  } catch {
    console.error(
      style(['red', 'bold'], `${error} Unknown template ${template}.\n`),
    );
    printAvailableTemplates();
    console.log('');
    process.exit(1);
    return;
  }

  if (name === '.') {
    if ((await fs.readdir(name)).length !== 0) {
      console.error(style(['red', 'bold'], `${error} Directory is not empty.`));
      process.exit(1);
      return;
    }
  } else {
    try {
      await fs.stat(name);
      console.error(style(['red', 'bold'], `${error} ${name} already exists.`));
      process.exit(1);
      return;
    } catch {
      // ignore
    }
    await fs.mkdir(name, {recursive: true});
  }

  await spawn('git', ['init'], {
    stdio: 'inherit',
    cwd: name,
  });

  await fs.cp(templateDir, name, {
    recursive: true,
  });

  let packageManager = getCurrentPackageManager()?.name;
  switch (packageManager) {
    case 'yarn':
      await spawn('yarn', [], {cwd: name, stdio: 'inherit'});
      break;
    case 'pnpm':
      await spawn('pnpm', ['install'], {cwd: name, stdio: 'inherit'});
      break;
    case 'npm':
    default:
      await spawn(
        'npm',
        ['install', '--legacy-peer-deps', '--no-audit', '--no-fund'],
        {cwd: name, stdio: 'inherit'},
      );
      break;
  }

  await spawn('git', ['add', '-A'], {cwd: name});
  await spawn(
    'git',
    ['commit', '--quiet', '-a', '-m', 'Initial commit from create-parcel'],
    {
      stdio: 'inherit',
      cwd: name,
    },
  );

  console.log('');
  console.log(style(['green', 'bold'], `${success} Your new app is ready!\n`));
  console.log('To get started, run the following commands:');
  console.log('');
  if (name !== '.') {
    console.log(`  cd ${name}`);
  }
  console.log(`  ${packageManager ?? 'npm'} start`);
  console.log('');
}

function spawn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let p = _spawn(cmd, args, opts);
    p.on('close', (code, signal) => {
      if (code || signal) {
        reject(new Error(`${cmd} failed with exit code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

function getCurrentPackageManager(
  userAgent: ?string = process.env.npm_config_user_agent,
): ?{|name: string, version: string|} {
  if (!userAgent) {
    return undefined;
  }

  const pmSpec = userAgent.split(' ')[0];
  const separatorPos = pmSpec.lastIndexOf('/');
  const name = pmSpec.substring(0, separatorPos);
  return {
    name: name,
    version: pmSpec.substring(separatorPos + 1),
  };
}

function printAvailableTemplates() {
  console.error('Available templates:\n');
  for (let dir of readdirSync(path.join(__dirname, '..', 'templates'))) {
    console.error(`  • ${dir}`);
  }
}

// From https://github.com/sindresorhus/is-unicode-supported/blob/8f123916d5c25a87c4f966dcc248b7ca5df2b4ca/index.js
// This package is ESM-only so it has to be vendored
function isUnicodeSupported() {
  if (process.platform !== 'win32') {
    return process.env.TERM !== 'linux'; // Linux console (kernel)
  }

  return (
    Boolean(process.env.CI) ||
    Boolean(process.env.WT_SESSION) || // Windows Terminal
    process.env.ConEmuTask === '{cmd::Cmder}' || // ConEmu and cmder
    process.env.TERM_PROGRAM === 'vscode' ||
    process.env.TERM === 'xterm-256color' ||
    process.env.TERM === 'alacritty'
  );
}

function style(format, text) {
  if (styleText) {
    return styleText(format, text);
  } else {
    return text;
  }
}
