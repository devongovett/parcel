import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  overlayFS,
  fsFixture,
  assertBundles,
} from '@parcel/test-utils';
import React from 'react';
import ReactDOM from 'react-dom/server';

describe('mdx', function () {
  let count = 0;
  let dir;
  beforeEach(async () => {
    dir = path.join(__dirname, 'mdx', '' + ++count);
    await overlayFS.mkdirp(dir);
  });

  after(async () => {
    await overlayFS.rimraf(path.join(__dirname, 'mdx'));
  });

  it('should support bundling MDX', async function () {
    let b = await bundle(path.join(__dirname, '/integration/mdx/index.mdx'));

    let output = await run(b);
    assert.equal(typeof output.default, 'function');
  });

  it('should support bundling MDX with React 17', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/mdx-react-17/index.mdx'),
    );

    let output = await run(b);
    assert.equal(typeof output.default, 'function');
  });

  it('should expose static exports on asset.meta', async function () {
    await fsFixture(overlayFS, dir)`
      index.mdx:
        export const navTitle = 'Hello';

        # Testing

        foo bar
    `;

    let b = await bundle(path.join(dir, 'index.mdx'), {inputFS: overlayFS});
    let asset = b.getBundles()[0].getMainEntry();

    assert.deepEqual(asset.meta.ssgMeta.exports, {
      navTitle: 'Hello',
    });
  });

  it('should expose table of contents on asset.meta', async function () {
    await fsFixture(overlayFS, dir)`
      index.mdx:
        # Testing

        foo bar

        ## Subtitle

        another paragraph

        ### Sub subtitle

        yo

        ## Another subtitle

        yay
    `;

    let b = await bundle(path.join(dir, 'index.mdx'), {inputFS: overlayFS});
    let asset = b.getBundles()[0].getMainEntry();

    assert.deepEqual(asset.meta.ssgMeta.tableOfContents, [
      {
        level: 1,
        title: 'Testing',
        children: [
          {
            level: 2,
            title: 'Subtitle',
            children: [
              {
                level: 3,
                title: 'Sub subtitle',
                children: [],
              },
            ],
          },
          {
            level: 2,
            title: 'Another subtitle',
            children: [],
          },
        ],
      },
    ]);
  });

  it('should support dependencies', async function () {
    await fsFixture(overlayFS, dir)`
      index.mdx:
        Testing [urls](another.mdx).

        <audio src="some.mp3" />

      another.mdx:
        Another mdx file with an image.

        ![alt](img.png)

      img.png:

      some.mp3:
    `;

    let b = await bundle(path.join(dir, 'index.mdx'), {inputFS: overlayFS});
    assertBundles(
      b,
      [
        {
          name: 'index.js',
          assets: ['index.mdx'],
        },
        {
          name: 'another.js',
          assets: ['another.mdx'],
        },
        {
          assets: ['img.png'],
        },
        {
          assets: ['some.mp3'],
        },
      ],
      {skipNodeModules: true},
    );
  });

  it('should support code block props', async function () {
    await fsFixture(overlayFS, dir)`
      index.mdx:
        \`\`\`tsx boolean string="hi" value={2}
        console.log("hi");
        \`\`\`
    `;

    let b = await bundle(path.join(dir, 'index.mdx'), {inputFS: overlayFS});
    let output = await run(b);
    let codeBlockProps;
    function CodeBlock(v) {
      codeBlockProps = v;
      return <pre>{v.children}</pre>;
    }
    let res = ReactDOM.renderToStaticMarkup(
      React.createElement(output.default, {components: {CodeBlock}}),
    );
    assert.equal(res, '<pre>console.log(&quot;hi&quot;);</pre>');
    assert.deepEqual(codeBlockProps, {
      boolean: true,
      string: 'hi',
      value: 2,
      lang: 'tsx',
      children: 'console.log("hi");',
    });
  });

  it('should support rendering code blocks', async function () {
    await fsFixture(overlayFS, dir)`
      index.mdx:
        \`\`\`tsx render
        <div>Hello</div>
        \`\`\`
      package.json:
        {"dependencies": {"react": "^19"}}
    `;

    let b = await bundle(path.join(dir, 'index.mdx'), {inputFS: overlayFS});
    let output = await run(b);
    let res = ReactDOM.renderToStaticMarkup(
      React.createElement(output.default),
    );
    assert.equal(
      res,
      '<pre><code class="language-tsx">&lt;div&gt;Hello&lt;/div&gt;</code></pre><div>Hello</div>',
    );
  });

  it('should support rendering CSS', async function () {
    await fsFixture(overlayFS, dir)`
      index.mdx:
        \`\`\`css render
        .foo { color: red }
        \`\`\`
    `;

    let b = await bundle(path.join(dir, 'index.mdx'), {inputFS: overlayFS});
    assertBundles(
      b,
      [
        {
          name: 'index.js',
          assets: ['index.mdx', 'mdx-components.jsx'],
        },
        {
          name: 'index.css',
          assets: ['index.mdx'],
        },
      ],
      {skipNodeModules: true},
    );

    let output = await run(b);
    let res = ReactDOM.renderToStaticMarkup(
      React.createElement(output.default),
    );
    assert.equal(
      res,
      '<pre><code class="language-css">.foo { color: red }</code></pre>',
    );

    let css = await overlayFS.readFile(b.getBundles()[1].filePath, 'utf8');
    assert(css.includes('color: red'));
  });
});
