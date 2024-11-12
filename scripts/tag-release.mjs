/* eslint-disable no-console */

import {execSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';

import {program} from 'commander';

async function main(tag) {
  let publishSummary = JSON.parse(
    await readFile(
      new URL('../lerna-publish-summary.json', import.meta.url).pathname,
      'utf8',
    ),
  );

  for (let {packageName, version} of publishSummary) {
    execSync(`npm dist-tag add ${packageName}@${version} ${tag}`, {
      encoding: 'utf8',
    });
  }
}

let {tag} = program
  // TODO Use requiredOption once commander is upgraded in the root
  .option(
    '--tag <tag>',
    'The npm tag to add to every package published in the latest release',
  )
  .parse(process.argv)
  .opts();

if (!tag) {
  throw new Error('Required option `tag` not specified');
}

main(tag).then(() => {
  console.log(`Successfully added @${tag} to released packages`);
});
