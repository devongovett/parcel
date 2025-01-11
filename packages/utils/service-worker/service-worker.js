export let manifest = [];
export let precacheManifest = [];
export let version = '';

// Called by the runtime.
export function _register(m, pm, v) {
  manifest = m;
  precacheManifest = pm;
  version = v;
}
