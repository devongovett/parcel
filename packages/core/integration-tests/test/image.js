import assert from 'assert';
import {bundle, distDir, inputFS, outputFS} from '@parcel/test-utils';
import path from 'path';
import sharp from 'sharp';

describe('image', function() {
  this.timeout(10000);

  it('Should be able to resize images', async () => {
    await bundle(path.join(__dirname, '/integration/image/resized.js'));

    let dirContent = await outputFS.readdir(distDir);
    let imagePath = '';
    let foundExtensions = [];
    for (let filename of dirContent) {
      let ext = path.extname(filename);
      foundExtensions.push(ext);
      if (ext === '.jpg') {
        imagePath = path.join(distDir, filename);
      }
    }
    assert.deepStrictEqual(
      foundExtensions.sort(),
      ['.jpg', '.js', '.map'].sort(),
    );

    let buffer = await outputFS.readFile(imagePath);
    let image = await sharp(buffer).metadata();
    assert.equal(image.width, 600);
  });

  it('Should be able to import an image using multiple varying query parameters', async () => {
    await bundle(
      path.join(__dirname, '/integration/image-multiple-queries/index.html'),
    );

    let dirContent = await outputFS.readdir(distDir);
    let foundExtensions = [];
    for (let filename of dirContent) {
      const foundExt = path.extname(filename);
      if (foundExt !== '.map') {
        foundExtensions.push(foundExt);
      }
    }

    assert.deepStrictEqual(
      foundExtensions.sort(),
      ['.jpg', '.jpg', '.webp', '.html'].sort(),
    );
  });

  describe('Should be able to change image format', () => {
    function testCase(ext) {
      return async () => {
        await bundle(
          path.join(__dirname, `/integration/image/reformat.${ext}`),
        );

        let dirContent = await outputFS.readdir(distDir);
        let foundExtensions = [];
        for (let filename of dirContent) {
          const foundExt = path.extname(filename);
          if (foundExt !== '.map') {
            foundExtensions.push(foundExt);
          }
        }
        assert.deepStrictEqual(
          foundExtensions.sort(),
          ['.webp', `.${ext}`].sort(),
        );
      };
    }

    it('from JS', testCase('js'));
    it('from HTML', testCase('html'));
    it('from CSS', testCase('css'));

    it('all formats', async () => {
      let b = await bundle(
        path.join(__dirname, `/integration/image/reformat-all.html`),
      );

      let foundExtensions = new Set(b.getBundles().map(({type}) => type));

      assert.deepStrictEqual(
        foundExtensions,
        new Set(['html', 'webp', 'avif', 'jpg', 'png', 'tiff']),
      );
    });
  });

  it('should optimise JPEGs', async function() {
    let img = path.join(__dirname, '/integration/image/image.jpg');
    let b = await bundle(img, {
      defaultTargetOptions: {
        shouldOptimize: true,
      },
    });

    const imagePath = b.getBundles().find(b => b.type === 'jpg').filePath;

    let input = await inputFS.readFile(img);
    let inputRaw = await sharp(input)
      .toFormat('raw')
      .toBuffer();
    let output = await outputFS.readFile(imagePath);
    let outputRaw = await sharp(output)
      .toFormat('raw')
      .toBuffer();

    assert(outputRaw.equals(inputRaw));
    assert(output.length < input.length);
  });

  it('should optimise PNGs', async function() {
    let img = path.join(__dirname, '/integration/image/clock.png');
    let b = await bundle(img, {
      defaultTargetOptions: {
        shouldOptimize: true,
      },
    });

    const imagePath = b.getBundles().find(b => b.type === 'png').filePath;

    let input = await inputFS.readFile(img);
    let inputRaw = await sharp(input)
      .toFormat('raw')
      .toBuffer();
    let output = await outputFS.readFile(imagePath);
    let outputRaw = await sharp(output)
      .toFormat('raw')
      .toBuffer();

    assert(outputRaw.equals(inputRaw));
    assert(output.length < input.length);
  });
});
