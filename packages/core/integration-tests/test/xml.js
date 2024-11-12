import assert from 'assert';
import path from 'path';
import {assertBundles, bundle, outputFS} from '@parcel/test-utils';

describe('xml', function () {
  it('should transform an atom feed', async function () {
    let b = await bundle(path.join(__dirname, '/integration/xml/atom.xml'), {
      defaultTargetOptions: {
        publicUrl: 'http://example.org/',
      },
    });

    assertBundles(b, [
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'xhtml',
        assets: ['atom.xml'],
      },
      {
        type: 'xsl',
        assets: ['atom.xsl'],
      },
      {
        name: 'post.html',
        assets: ['post.html'],
      },
      {
        name: 'atom.xml',
        assets: ['atom.xml'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      contents.includes(
        `<?xml-stylesheet type="text/xsl" href="http://example.org/${path.basename(
          b.getBundles().find(b => b.type === 'xsl').filePath,
        )}"?>`,
      ),
    );
    assert(
      contents.includes(
        `<img src="http://example.org/${path.basename(
          b.getBundles().find(b => b.type === 'png').filePath,
        )}"/>`,
      ),
    );
    assert(contents.includes(`<link href="http://example.org/post.html"/>`));
  });

  it('should transform an atom feed with namespaced elements', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/xml/atom-namespace.xml'),
      {
        defaultTargetOptions: {
          publicUrl: 'http://example.org/',
        },
      },
    );

    assertBundles(b, [
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'xhtml',
        assets: ['atom-namespace.xml'],
      },
      {
        type: 'xsl',
        assets: ['atom.xsl'],
      },
      {
        name: 'post.html',
        assets: ['post.html'],
      },
      {
        name: 'atom-namespace.xml',
        assets: ['atom-namespace.xml'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      contents.includes(
        `<?xml-stylesheet type="text/xsl" href="http://example.org/${path.basename(
          b.getBundles().find(b => b.type === 'xsl').filePath,
        )}"?>`,
      ),
    );
    assert(
      contents.includes(
        `<img src="http://example.org/${path.basename(
          b.getBundles().find(b => b.type === 'png').filePath,
        )}"/>`,
      ),
    );
    assert(
      contents.includes(`<atom:link href="http://example.org/post.html"/>`),
    );
  });

  it('should transform an rss feed', async function () {
    let b = await bundle(path.join(__dirname, '/integration/xml/rss.xml'), {
      defaultTargetOptions: {
        publicUrl: 'http://example.org/',
      },
    });

    assertBundles(b, [
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'html',
        assets: ['rss.xml'],
      },
      {
        type: 'html',
        assets: ['rss.xml'],
      },
      {
        name: 'post.html',
        assets: ['post.html'],
      },
      {
        name: 'rss.xml',
        assets: ['rss.xml'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      contents.includes(
        `&lt;img src="http://example.org/${path.basename(
          b.getBundles().find(b => b.type === 'png').filePath,
        )}"&gt;`,
      ),
    );
    assert(contents.includes(`<link>http://example.org/post.html</link>`));
  });
});
