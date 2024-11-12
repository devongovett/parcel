use std::{mem, ptr, slice};

use mozjpeg_sys::*;
use napi::{bindgen_prelude::*, Env, Error, JsBuffer, Result};
use napi_derive::napi;
use oxipng::optimize_from_memory;

#[napi]
pub fn optimize_image(kind: String, buf: Buffer, env: Env) -> Result<JsBuffer> {
  let slice = buf.as_ref();

  match kind.as_ref() {
    "png" => match optimize_from_memory(slice, &Default::default()) {
      Ok(res) => Ok(env.create_buffer_with_data(res)?.into_raw()),
      Err(err) => Err(Error::from_reason(format!("{}", err))),
    },
    "jpg" | "jpeg" => unsafe {
      match optimize_jpeg(slice) {
        Ok(res) => Ok(
          env
            .create_buffer_with_borrowed_data(
              res.as_mut_ptr(),
              res.len(),
              res.as_mut_ptr(),
              finalize,
            )?
            .into_raw(),
        ),
        Err(err) => {
          if let Some(msg) = err.downcast_ref::<String>() {
            Err(Error::from_reason(msg.to_string()))
          } else {
            Err(Error::from_reason("Unknown libjpeg error"))
          }
        }
      }
    },
    _ => Err(Error::from_reason(format!("Unknown image type {}", kind))),
  }
}

fn finalize(ptr: *mut u8, _env: Env) {
  unsafe {
    libc::free(ptr as *mut c_void);
  }
}

struct JPEGOptimizer {
  srcinfo: jpeg_decompress_struct,
  dstinfo: jpeg_compress_struct,
}

impl JPEGOptimizer {
  unsafe fn new() -> JPEGOptimizer {
    JPEGOptimizer {
      srcinfo: mem::zeroed(),
      dstinfo: mem::zeroed(),
    }
  }
}

impl Drop for JPEGOptimizer {
  fn drop(&mut self) {
    unsafe {
      jpeg_destroy_decompress(&mut self.srcinfo);
      jpeg_destroy_compress(&mut self.dstinfo);
    }
  }
}

// This function losslessly optimizes jpegs.
// Based on the jpegtran.c example program in libjpeg.
unsafe fn optimize_jpeg(bytes: &[u8]) -> std::thread::Result<&mut [u8]> {
  std::panic::catch_unwind(|| {
    let mut info = JPEGOptimizer::new();
    let mut err = create_error_handler();
    info.srcinfo.common.err = &mut err;
    jpeg_create_decompress(&mut info.srcinfo);
    jpeg_mem_src(&mut info.srcinfo, bytes.as_ptr(), bytes.len() as c_ulong);

    info.dstinfo.optimize_coding = 1;
    info.dstinfo.common.err = &mut err;
    jpeg_create_compress(&mut info.dstinfo);
    jpeg_read_header(&mut info.srcinfo, 1);

    let src_coef_arrays = jpeg_read_coefficients(&mut info.srcinfo);
    jpeg_copy_critical_parameters(&info.srcinfo, &mut info.dstinfo);

    let mut buf = ptr::null_mut();
    let mut outsize: c_ulong = 0;
    jpeg_mem_dest(&mut info.dstinfo, &mut buf, &mut outsize);

    jpeg_write_coefficients(&mut info.dstinfo, src_coef_arrays);

    jpeg_finish_compress(&mut info.dstinfo);
    jpeg_finish_decompress(&mut info.srcinfo);

    slice::from_raw_parts_mut(buf, outsize as usize)
  })
}

unsafe fn create_error_handler() -> jpeg_error_mgr {
  let mut err: jpeg_error_mgr = mem::zeroed();
  jpeg_std_error(&mut err);
  err.error_exit = Some(unwind_error_exit);
  err.emit_message = Some(silence_message);
  err
}

extern "C-unwind" fn unwind_error_exit(cinfo: &mut jpeg_common_struct) {
  let message = unsafe {
    let err = cinfo.err.as_ref().unwrap();
    match err.format_message {
      Some(fmt) => {
        let buffer = mem::zeroed();
        fmt(cinfo, &buffer);
        let len = buffer.iter().take_while(|&&c| c != 0).count();
        String::from_utf8_lossy(&buffer[..len]).into()
      }
      None => format!("libjpeg error: {}", err.msg_code),
    }
  };
  std::panic::resume_unwind(Box::new(message))
}

extern "C-unwind" fn silence_message(_cinfo: &mut jpeg_common_struct, _level: c_int) {}
