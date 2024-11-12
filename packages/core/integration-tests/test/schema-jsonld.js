import {assertBundles, bundle, distDir, outputFS} from '@parcel/test-utils';
import path from 'path';
import assert from 'assert';

describe('jsonld', function () {
  it('Should parse a LD+JSON schema and collect dependencies', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/schema-jsonld/index.html'),
      {
        publicURL: 'https://place.holder/',
      },
    );

    assertBundles(b, [
      {
        type: 'jsonld',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['other.css'],
      },
      {
        type: 'png',
        assets: ['logo.png'],
      },
      {
        type: 'jpeg',
        assets: ['image.jpeg'],
      },
    ]);

    let file = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf-8',
    );
    let contentBetweenScriptTag = new RegExp(
      /<\s*script \s*type="application\/ld\+json"\s*>(.*)<\/\s*script\s*>/gm,
    ).exec(file)[1];

    let jsonldData = assertValidJsonObject(contentBetweenScriptTag);
    match(jsonldData.logo.url, /logo\.[a-f0-9]+\.png/);
    match(jsonldData.image[0], /image\.[a-f0-9]+\.jpeg/);
    match(jsonldData.image[1], /image\.[a-f0-9]+\.jpeg/);
  });
});

function match(test, pattern) {
  let success = new RegExp(pattern).test(test);
  if (success) {
    assert.ok(`'${test}' matched the given pattern of '${pattern}'`);
    return;
  }
  assert.fail(`'${test}' did not match the given pattern of '${pattern}'`);
}

function assertValidJsonObject(dataAsString) {
  try {
    let data = JSON.parse(dataAsString);
    assert.ok('input string is a valid json object');
    return data;
  } catch (e) {
    assert.fail(
      `the given string (see below) is not a valid json object\n\terror :: ${e}\n\tinput :: ${dataAsString}`,
    );
  }
}
