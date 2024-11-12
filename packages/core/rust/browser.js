const {Environment, napi} = require('napi-wasm');

let env;
module.exports.init = async function init(input) {
  if (env) return;

  input = input ?? new URL('parcel_node_bindings.wasm', import.meta.url);
  const {instance} = await WebAssembly.instantiateStreaming(fetch(input), {
    env: {
      ...napi,
      __getrandom_custom: (ptr, len) => {
        let buf = env.memory.subarray(ptr, ptr + len);
        crypto.getRandomValues(buf);
      },
      log: (ptr, len) => {
        // eslint-disable-next-line no-console
        console.log(env.getString(ptr, len));
      },
    },
  });

  // input =
  //   input ?? require('path').join(__dirname, 'parcel_node_bindings.wasm');
  // const {instance} = await WebAssembly.instantiate(
  //   require('fs').readFileSync(input),
  //   {
  //     env: napi,
  //   },
  // );

  for (let key in instance.exports) {
    if (key.startsWith('__napi_register__')) {
      instance.exports[key]();
    }
  }

  env = new Environment(instance);

  for (let key in env.exports) {
    if (key !== 'transform') {
      module.exports[key] = env.exports[key];
    }
  }
  module.exports.transform = function (config) {
    let result = env.exports.transform(config);
    return {
      ...result,
      // Hydrate Uint8Array into Buffer
      code: Buffer.from(result.code),
    };
  };

  env.exports.initPanicHook();
};
