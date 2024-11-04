/* eslint-disable no-console */
const fs = require('fs');
const glob = require('fast-glob');
const path = require('path');
const {spawn, execSync} = require('child_process');

let release = process.argv.includes('--release');
let canary = process.argv.includes('--canary');
let wasm = process.argv.includes('--wasm');

build();

async function build() {
  if (process.env.CI && process.platform === 'darwin') {
    setupMacBuild();
  }

  let packages = glob.sync('packages/*/*', {onlyFiles: false});
  for (let pkg of packages) {
    try {
      let pkgJSON = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json')));
      if (!wasm && !pkgJSON.napi) continue;
      if (wasm && !pkgJSON.scripts?.['wasm:build-release']) continue;
    } catch (err) {
      continue;
    }

    console.log(`Building ${pkg}...`);
    await new Promise((resolve, reject) => {
      let args = [];
      const prefix = wasm ? 'wasm:' : '';
      if (release) {
        args.push(prefix + 'build-release');
      } else if (canary) {
        args.push(prefix + 'build-canary');
      } else {
        args.push(prefix + 'build');
      }
      if (process.env.RUST_TARGET) {
        args.push('--target', process.env.RUST_TARGET);
      }

      let yarn = spawn('yarn', args, {
        stdio: 'inherit',
        cwd: pkg,
        shell: true,
      });

      yarn.on('close', code => (code === 0 ? resolve() : reject()));
    }).catch(() => process.exit(1));
  }
}

// This setup is necessary for cross-compilation for Apple Silicon in GitHub Actions.
function setupMacBuild() {
  // This forces Clang/LLVM to be used as a C compiler instead of GCC.
  process.env.CC = execSync('xcrun -f clang', {encoding: 'utf8'}).trim();
  process.env.CXX = execSync('xcrun -f clang++', {encoding: 'utf8'}).trim();

  let sysRoot = execSync('xcrun --sdk macosx --show-sdk-path', {
    encoding: 'utf8',
  }).trim();
  process.env.CFLAGS = `-isysroot ${sysRoot} -isystem ${sysRoot}`;
  process.env.MACOSX_DEPLOYMENT_TARGET = '10.9';

  if (process.env.RUST_TARGET === 'aarch64-apple-darwin') {
    // Prevents the "<jemalloc>: Unsupported system page size" error when
    // requiring parcel-node-bindings.darwin-arm64.node
    process.env.JEMALLOC_SYS_WITH_LG_PAGE = 14;
  }
}
