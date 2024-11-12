use std::sync::Arc;

use crossbeam_channel::{Receiver, Sender};
use indexmap::IndexMap;
use napi::{
  threadsafe_function::{ThreadSafeCallContext, ThreadsafeFunctionCallMode},
  Env, JsBoolean, JsFunction, JsNumber, JsObject, JsString, JsUnknown, ValueType,
};
use napi_derive::napi;
use swc_core::common::DUMMY_SP;

use crate::{JsValue, Location, MacroCallback, MacroError};

struct CallMacroMessage {
  src: String,
  export: String,
  args: Vec<JsValue>,
  loc: Location,
}

#[napi(object)]
struct JsMacroError {
  pub kind: u32,
  pub message: String,
}

// Allocate a single channel per thread to communicate with the JS thread.
thread_local! {
  static CHANNEL: (Sender<Result<JsValue, MacroError>>, Receiver<Result<JsValue, MacroError>>) = crossbeam_channel::unbounded();
}

/// Creates a macro callback from a JS function.
pub fn create_macro_callback(function: JsFunction, env: Env) -> napi::Result<MacroCallback> {
  let call_macro_tsfn = env.create_threadsafe_function(
    &function,
    0,
    |ctx: ThreadSafeCallContext<CallMacroMessage>| {
      let src = ctx.env.create_string(&ctx.value.src)?.into_unknown();
      let export = ctx.env.create_string(&ctx.value.export)?.into_unknown();
      let args = js_value_to_napi(JsValue::Array(ctx.value.args), ctx.env)?;
      let loc = ctx.env.to_js_value(&ctx.value.loc)?;
      Ok(vec![src, export, args, loc])
    },
  )?;

  // Get around Env not being Send. See safety note below.
  let unsafe_env = env.raw() as usize;

  Ok(Arc::new(move |src, export, args, loc| {
    CHANNEL.with(|channel| {
      // Call JS function to run the macro.
      let tx = channel.0.clone();
      call_macro_tsfn.call_with_return_value(
        Ok(CallMacroMessage {
          src,
          export,
          args,
          loc,
        }),
        ThreadsafeFunctionCallMode::Blocking,
        move |v: JsUnknown| {
          // When the JS function returns, await the promise, and send the result
          // through the channel back to the native thread.
          // SAFETY: this function is called from the JS thread.
          await_promise(unsafe { Env::from_raw(unsafe_env as _) }, v, tx)?;
          Ok(())
        },
      );
      // Lock the transformer thread until the JS thread returns a result.
      channel.1.recv().expect("receive failure")
    })
  }))
}

/// Convert a JsValue macro argument from the transformer to a napi value.
fn js_value_to_napi(value: JsValue, env: Env) -> napi::Result<napi::JsUnknown> {
  match value {
    JsValue::Undefined => Ok(env.get_undefined()?.into_unknown()),
    JsValue::Null => Ok(env.get_null()?.into_unknown()),
    JsValue::Bool(b) => Ok(env.get_boolean(b)?.into_unknown()),
    JsValue::Number(n) => Ok(env.create_double(n)?.into_unknown()),
    JsValue::String(s) => Ok(env.create_string_from_std(s)?.into_unknown()),
    JsValue::Regex { source, flags } => {
      let regexp_class: JsFunction = env.get_global()?.get_named_property("RegExp")?;
      let source = env.create_string_from_std(source)?;
      let flags = env.create_string_from_std(flags)?;
      let re = regexp_class.new_instance(&[source, flags])?;
      Ok(re.into_unknown())
    }
    JsValue::Array(arr) => {
      let mut res = env.create_array(arr.len() as u32)?;
      for (i, val) in arr.into_iter().enumerate() {
        res.set(i as u32, js_value_to_napi(val, env)?)?;
      }
      Ok(res.coerce_to_object()?.into_unknown())
    }
    JsValue::Object(obj) => {
      let mut res = env.create_object()?;
      for (k, v) in obj {
        res.set_named_property(&k, js_value_to_napi(v, env)?)?;
      }
      Ok(res.into_unknown())
    }
    JsValue::Function(_) => {
      // Functions can only be returned from macros, not passed in.
      unreachable!()
    }
  }
}

/// Convert a napi value returned as a result of a macro to a JsValue for the transformer.
fn napi_to_js_value(value: napi::JsUnknown, env: Env) -> napi::Result<JsValue> {
  match value.get_type()? {
    ValueType::Undefined => Ok(JsValue::Undefined),
    ValueType::Null => Ok(JsValue::Null),
    ValueType::Number => Ok(JsValue::Number(
      unsafe { value.cast::<JsNumber>() }.get_double()?,
    )),
    ValueType::Boolean => Ok(JsValue::Bool(
      unsafe { value.cast::<JsBoolean>() }.get_value()?,
    )),
    ValueType::String => Ok(JsValue::String(
      unsafe { value.cast::<JsString>() }
        .into_utf8()?
        .into_owned()?,
    )),
    ValueType::Object => {
      let obj = unsafe { value.cast::<JsObject>() };
      if obj.is_array()? {
        let len = obj.get_array_length()?;
        let mut arr = Vec::with_capacity(len as usize);
        for i in 0..len {
          let elem = napi_to_js_value(obj.get_element(i)?, env)?;
          arr.push(elem);
        }
        Ok(JsValue::Array(arr))
      } else {
        let regexp_class: JsFunction = env.get_global()?.get_named_property("RegExp")?;
        if obj.instanceof(regexp_class)? {
          let source: JsString = obj.get_named_property("source")?;
          let flags: JsString = obj.get_named_property("flags")?;
          return Ok(JsValue::Regex {
            source: source.into_utf8()?.into_owned()?,
            flags: flags.into_utf8()?.into_owned()?,
          });
        }

        let names = obj.get_property_names()?;
        let len = names.get_array_length()?;
        let mut props = IndexMap::with_capacity(len as usize);
        for i in 0..len {
          let prop = names.get_element::<JsString>(i)?;
          let name = prop.into_utf8()?.into_owned()?;
          let value = napi_to_js_value(obj.get_property(prop)?, env)?;
          props.insert(name, value);
        }
        Ok(JsValue::Object(props))
      }
    }
    ValueType::Function => {
      let f = unsafe { value.cast::<JsFunction>() };
      let source = f.coerce_to_string()?.into_utf8()?.into_owned()?;
      Ok(JsValue::Function(source))
    }
    ValueType::Symbol | ValueType::External | ValueType::Unknown => Err(napi::Error::new(
      napi::Status::GenericFailure,
      "Could not convert value returned from macro to AST.",
    )),
  }
}

fn await_promise(
  env: Env,
  result: JsUnknown,
  tx: Sender<Result<JsValue, MacroError>>,
) -> napi::Result<()> {
  // If the result is a promise, wait for it to resolve, and send the result to the channel.
  // Otherwise, send the result immediately.
  if result.is_promise()? {
    let result: JsObject = result.try_into()?;
    let then: JsFunction = result.get_named_property("then")?;
    let tx2 = tx.clone();
    let cb = env.create_function_from_closure("callback", move |ctx| {
      let res = napi_to_js_value(ctx.get::<JsUnknown>(0)?, env)?;
      tx.send(Ok(res)).expect("send failure");
      ctx.env.get_undefined()
    })?;
    let eb = env.create_function_from_closure("error_callback", move |ctx| {
      let res = ctx.get::<JsMacroError>(0)?;
      let err = match res.kind {
        1 => MacroError::LoadError(res.message, DUMMY_SP),
        2 => MacroError::ExecutionError(res.message, DUMMY_SP),
        _ => MacroError::LoadError("Invalid error kind".into(), DUMMY_SP),
      };
      tx2.send(Err(err)).expect("send failure");
      ctx.env.get_undefined()
    })?;
    then.call(Some(&result), &[cb, eb])?;
  } else {
    tx.send(Ok(napi_to_js_value(result, env)?))
      .expect("send failure");
  }

  Ok(())
}
