const {Transform} = require('stream');
const babel = require('gulp-babel');
const gulp = require('gulp');
const path = require('path');
const {rimraf} = require('rimraf');
const babelConfig = require('./babel.config.json');

const IGNORED_PACKAGES = [
  '!packages/examples/**',
  '!packages/core/integration-tests/**',
  '!packages/core/workers/test/integration/**',
  '!packages/core/test-utils/**',
  '!packages/core/types/**',
  '!packages/core/types-internal/**',

  // These packages are bundled.
  '!packages/core/codeframe/**',
  '!packages/core/fs/**',
  '!packages/core/package-manager/**',
  '!packages/core/utils/**',
  '!packages/reporters/cli/**',
  '!packages/reporters/dev-server/**',
];

const paths = {
  packageSrc: [
    'packages/*/*/src/**/*.js',
    '!**/dev-prelude.js',
    ...IGNORED_PACKAGES,
  ],
  packageOther: ['packages/*/*/src/**/dev-prelude.js'],
  packageJson: [
    'packages/core/parcel/package.json',
    'packages/utils/create-react-app/package.json',
    'packages/dev/query/package.json',
    'packages/dev/bundle-stats-cli/package.json',
  ],
  packages: 'packages/',
};

/*
 * "Taps" into the contents of a flowing stream, yielding chunks to the passed
 * callback. Continues to pass data chunks down the stream.
 */
class TapStream extends Transform {
  constructor(tap, options) {
    super({...options, objectMode: true});
    this._tap = tap;
  }

  _transform(chunk, encoding, callback) {
    try {
      this._tap(chunk);
      callback(null, chunk);
    } catch (err) {
      callback(err);
    }
  }
}

exports.clean = function clean(cb) {
  rimraf('packages/*/*/lib/**').then(
    () => cb(),
    err => cb(err),
  );
};

exports.default = exports.build = gulp.series(
  gulp.parallel(buildBabel, copyOthers),
  // Babel reads from package.json so update these after babel has run
  paths.packageJson.map(
    packageJsonPath =>
      function updatePackageJson() {
        return _updatePackageJson(packageJsonPath);
      },
  ),
);

function buildBabel() {
  return gulp
    .src(paths.packageSrc)
    .pipe(babel({...babelConfig, babelrcRoots: [__dirname + '/packages/*/*']}))
    .pipe(renameStream(relative => relative.replace('src', 'lib')))
    .pipe(gulp.dest(paths.packages));
}

function copyOthers() {
  return gulp
    .src(paths.packageOther)
    .pipe(renameStream(relative => relative.replace('src', 'lib')))
    .pipe(gulp.dest(paths.packages));
}

function _updatePackageJson(file) {
  return gulp
    .src(file)
    .pipe(
      new TapStream(vinyl => {
        let json = JSON.parse(vinyl.contents);
        // Replace all references to `src` in package.json bin entries
        // `lib` equivalents.
        if (typeof json.bin === 'object' && json.bin != null) {
          for (let [binName, binPath] of Object.entries(json.bin)) {
            json.bin[binName] = binPath.replace('src', 'lib');
          }
        } else if (typeof json.bin === 'string') {
          json.bin = json.bin.replace('src', 'lib');
        }

        vinyl.contents = Buffer.from(JSON.stringify(json, null, 2));
      }),
    )
    .pipe(gulp.dest(path.dirname(file)));
}

function renameStream(fn) {
  return new TapStream(vinyl => {
    let relative = path.relative(vinyl.base, vinyl.path);
    vinyl.path = path.join(vinyl.base, fn(relative));
  });
}
