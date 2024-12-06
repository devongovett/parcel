import assert from 'assert';
import path from 'path';
import {bundle, distDir, outputFS, run} from '@parcel/test-utils';

describe('vue', function () {
  it('should produce a basic vue bundle', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-basic/Basic.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.deepEqual(output.data(), {msg: 'Hello from Component A!'});
  });
  it('should produce a vue bundle with dependencies', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-dependencies/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.deepEqual(output.data(), {msg: 'Welcome to Your Vue.js App!'});
  });
  it('should produce a vue bundle using preprocessors', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-preprocessors/pre-processors.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.deepEqual(output.data(), {msg: 'Hello from coffee!'});
    let contents = await outputFS.readFile(
      path.join(distDir, 'pre-processors.css'),
      'utf8',
    );
    assert(contents.includes('color: #999'));
    assert(contents.includes('background: red'));
    assert(contents.includes('color: green'));
  });
  it('should produce a vue bundle using scoped styles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-scoped/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert(/^data-v-[0-9a-h]{6}$/.test(output.__scopeId));
    assert.deepEqual(output.data(), {ok: true});
    let contents = await outputFS.readFile(
      path.join(distDir, 'App.css'),
      'utf8',
    );
    assert(contents.includes(`.test[${output.__scopeId}]`));
  });
  it('should produce a vue bundle using CSS modules', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-css-modules/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    let modules = output.__cssModules;
    assert.equal(typeof modules.$style.red, 'string');
    let contents = await outputFS.readFile(
      path.join(distDir, 'App.css'),
      'utf8',
    );
    assert(contents.includes('.' + modules.$style.red));
  });
  it('should bundle nested components dynamically', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-nested-components/testcomp.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.equal(typeof output.components.InsideComp, 'function');
  });
  it('should apply custom block preprocessors', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-custom-blocks/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.deepEqual(output.data().docs, {
      standard:
        '\nThis component represents the home page of the application.\n',
      brief: '\nHome Page\n',
    });
  });
  it('should produce a basic production vue bundle', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-basic/Basic.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.deepEqual(output.data(), {msg: 'Hello from Component A!'});
  });
  it('should load external templates/styles/scripts properly', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-external-files/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.deepEqual(output.data(), {msg: 'Hello World'});
    let contents = await outputFS.readFile(
      path.join(distDir, 'App.css'),
      'utf8',
    );
    assert(contents.includes('color: #c0ff33'));
    assert(contents.includes('h2:hover'));
    assert(contents.includes('.box p'));
  });
  it('should load <script setup> component files', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-script-setup/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.equal(typeof output.setup, 'function');
  });
  it('should process template with TS when script is TS', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/vue-ts-template/App.vue'),
    );
    let output = (await run(b)).default;
    assert.equal(typeof output.render, 'function');
    assert.equal(typeof output.setup, 'function');
  });
});
