use napi::{Env, JsObject, JsUnknown};
use napi_derive::napi;

#[napi]
pub fn transform_html(opts: JsObject, env: Env) -> napi::Result<JsUnknown> {
  let options: parcel_html::Options = env.from_js_value(opts)?;
  let result = parcel_html::transform_html(options);
  env.to_js_value(&result)
}
