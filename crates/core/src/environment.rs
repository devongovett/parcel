use std::{num::NonZeroU16, str::FromStr, sync::OnceLock};

use crate::{
  intern::{Interned, Interner},
  types::{impl_bitflags_serde, SourceLocation},
};
use bitflags::bitflags;
use browserslist::Distrib;
use parcel_resolver::IncludeNodeModules;
use serde::{Deserialize, Serialize};
use serde_repr::{Deserialize_repr, Serialize_repr};

#[derive(Clone, Debug, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
  pub context: EnvironmentContext,
  pub output_format: OutputFormat,
  pub source_type: SourceType,
  pub flags: EnvironmentFlags,
  pub source_map: Option<TargetSourceMapOptions>,
  pub loc: Option<SourceLocation>,
  pub include_node_modules: IncludeNodeModules,
  pub engines: Engines,
}

impl std::hash::Hash for Environment {
  fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
    // Doesn't include loc.
    self.context.hash(state);
    self.output_format.hash(state);
    self.source_type.hash(state);
    self.flags.hash(state);
    self.source_map.hash(state);
    self.include_node_modules.hash(state);
    self.engines.hash(state);
  }
}

impl PartialEq for Environment {
  fn eq(&self, other: &Self) -> bool {
    // Doesn't include loc.
    self.context == other.context
      && self.output_format == other.output_format
      && self.source_type == other.source_type
      && self.flags == other.flags
      && self.source_map == other.source_map
      && self.include_node_modules == other.include_node_modules
      && self.engines == other.engines
  }
}

#[derive(PartialEq, Eq, Clone, Debug, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSourceMapOptions {
  source_root: Option<String>,
  inline: Option<bool>,
  inline_sources: Option<bool>,
}

#[derive(PartialEq, Eq, Clone, Debug, Hash, Default, Serialize, Deserialize)]
pub struct Engines {
  #[serde(default)]
  pub browsers: Browsers,
  pub electron: Option<Version>,
  pub node: Option<Version>,
  pub parcel: Option<Version>,
}

#[derive(PartialEq, Clone, Copy, PartialOrd, Ord, Eq, Hash)]
pub struct Version(NonZeroU16);

impl Version {
  pub fn new(major: NonZeroU16, minor: u16) -> Self {
    Version(NonZeroU16::new((major.get() & 0xff) << 8 | (minor & 0xff)).unwrap())
  }

  pub fn major(&self) -> u16 {
    self.0.get() >> 8
  }

  pub fn minor(&self) -> u16 {
    self.0.get() & 0xff
  }
}

impl FromStr for Version {
  type Err = ();

  fn from_str(version: &str) -> Result<Self, Self::Err> {
    let version = version.split('-').next();
    if version.is_none() {
      return Err(());
    }

    let mut version = version.unwrap().split('.');
    let major = version.next().and_then(|v| v.parse::<NonZeroU16>().ok());
    if let Some(major) = major {
      let minor = version
        .next()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(0);
      // let patch = version.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
      return Ok(Version::new(major, minor));
    }

    Err(())
  }
}

impl std::fmt::Display for Version {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, ">= {}", self.major())?;
    if self.minor() > 0 {
      write!(f, "{}", self.minor())?;
    }
    Ok(())
  }
}

impl std::fmt::Debug for Version {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", self.major())?;
    if self.minor() > 0 {
      write!(f, "{}", self.minor())?;
    }
    Ok(())
  }
}

impl serde::Serialize for Version {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    format!("{}", self).serialize(serializer)
  }
}

impl<'de> serde::Deserialize<'de> for Version {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let v: String = serde::Deserialize::deserialize(deserializer)?;
    if let Some(version) = node_semver::Range::parse(v.as_str())
      .ok()
      .and_then(|r| r.min_version())
    {
      Ok(Version(
        NonZeroU16::new((version.major as u16) << 8 | (version.minor as u16))
          .ok_or(serde::de::Error::custom("version must be > 0"))?,
      ))
    } else {
      Err(serde::de::Error::custom("invalid semver range"))
    }
  }
}

#[derive(Default, PartialEq, Eq, Clone, Debug, Hash)]
pub struct Browsers {
  pub android: Option<Version>,
  pub chrome: Option<Version>,
  pub edge: Option<Version>,
  pub firefox: Option<Version>,
  pub ie: Option<Version>,
  pub ios_saf: Option<Version>,
  pub opera: Option<Version>,
  pub safari: Option<Version>,
  pub samsung: Option<Version>,
}

impl std::fmt::Display for Browsers {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let mut first = true;
    macro_rules! browser {
      ($b: ident) => {
        if let Some(v) = self.$b {
          if !first {
            write!(f, ", ")?;
          }
          first = false;
          write!(f, "{} {}", stringify!($b), v)?;
        }
      };
    }

    browser!(android);
    browser!(chrome);
    browser!(edge);
    browser!(firefox);
    browser!(ie);
    browser!(ios_saf);
    browser!(opera);
    browser!(safari);
    browser!(samsung);
    Ok(())
  }
}

impl From<Vec<Distrib>> for Browsers {
  fn from(distribs: Vec<Distrib>) -> Self {
    let mut browsers = Browsers::default();
    for distrib in distribs {
      macro_rules! browser {
        ($browser: ident) => {{
          if let Ok(v) = distrib.version().parse() {
            if browsers.$browser.is_none() || v < browsers.$browser.unwrap() {
              browsers.$browser = Some(v);
            }
          }
        }};
      }

      match distrib.name() {
        "android" => browser!(android),
        "chrome" | "and_chr" => browser!(chrome),
        "edge" => browser!(edge),
        "firefox" | "and_ff" => browser!(firefox),
        "ie" => browser!(ie),
        "ios_saf" => browser!(ios_saf),
        "opera" | "op_mob" => browser!(opera),
        "safari" => browser!(safari),
        "samsung" => browser!(samsung),
        _ => {}
      }
    }

    browsers
  }
}

#[derive(Serialize, Deserialize)]
struct SerializedBrowsers {
  pub android: Option<Version>,
  pub chrome: Option<Version>,
  pub edge: Option<Version>,
  pub firefox: Option<Version>,
  pub ie: Option<Version>,
  pub ios_saf: Option<Version>,
  pub opera: Option<Version>,
  pub safari: Option<Version>,
  pub samsung: Option<Version>,
}

impl serde::Serialize for Browsers {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    if serializer.is_human_readable() {
      format!("{}", self).serialize(serializer)
    } else {
      let s = SerializedBrowsers {
        android: self.android,
        chrome: self.chrome,
        edge: self.edge,
        firefox: self.firefox,
        ie: self.ie,
        ios_saf: self.ios_saf,
        opera: self.opera,
        safari: self.safari,
        samsung: self.samsung,
      };
      s.serialize(serializer)
    }
  }
}

impl<'de> serde::Deserialize<'de> for Browsers {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    if deserializer.is_human_readable() {
      let value = serde_value::Value::deserialize(deserializer)?;
      let browsers = match value {
        serde_value::Value::String(s) => vec![s],
        value => Vec::<String>::deserialize(serde_value::ValueDeserializer::new(value))?,
      };
      let distribs = browserslist::resolve(browsers, &Default::default()).unwrap_or(Vec::new());
      Ok(distribs.into())
    } else {
      let s = SerializedBrowsers::deserialize(deserializer)?;
      Ok(Browsers {
        android: s.android,
        chrome: s.chrome,
        edge: s.edge,
        firefox: s.firefox,
        ie: s.ie,
        ios_saf: s.ios_saf,
        opera: s.opera,
        safari: s.safari,
        samsung: s.samsung,
      })
    }
  }
}

// List of browsers to exclude when the esmodule target is specified.
// Based on https://caniuse.com/#feat=es6-module
const ESMODULE_BROWSERS: &'static [&'static str] = &[
  "not ie <= 11",
  "not edge < 16",
  "not firefox < 60",
  "not chrome < 61",
  "not safari < 11",
  "not opera < 48",
  "not ios_saf < 11",
  "not op_mini all",
  "not android < 76",
  "not blackberry > 0",
  "not op_mob > 0",
  "not and_chr < 76",
  "not and_ff < 68",
  "not ie_mob > 0",
  "not and_uc > 0",
  "not samsung < 8.2",
  "not and_qq > 0",
  "not baidu > 0",
  "not kaios > 0",
];

pub enum EnvironmentFeature {
  Esmodules,
  DynamicImport,
  WorkerModule,
  ServiceWorkerModule,
  ImportMetaUrl,
  ArrowFunctions,
  GlobalThis,
}

impl EnvironmentFeature {
  pub fn engines(&self) -> Engines {
    match self {
      EnvironmentFeature::WorkerModule => Engines {
        browsers: Browsers {
          edge: Some(Version::new(NonZeroU16::new(80).unwrap(), 0)),
          chrome: Some(Version::new(NonZeroU16::new(80).unwrap(), 0)),
          opera: Some(Version::new(NonZeroU16::new(67).unwrap(), 0)),
          android: Some(Version::new(NonZeroU16::new(81).unwrap(), 0)),
          ..Default::default()
        },
        ..Default::default()
      },
      EnvironmentFeature::DynamicImport => Engines {
        browsers: Browsers {
          edge: Some(Version::new(NonZeroU16::new(76).unwrap(), 0)),
          firefox: Some(Version::new(NonZeroU16::new(67).unwrap(), 0)),
          chrome: Some(Version::new(NonZeroU16::new(63).unwrap(), 0)),
          safari: Some(Version::new(NonZeroU16::new(11).unwrap(), 1)),
          opera: Some(Version::new(NonZeroU16::new(50).unwrap(), 0)),
          ios_saf: Some(Version::new(NonZeroU16::new(11).unwrap(), 3)),
          android: Some(Version::new(NonZeroU16::new(63).unwrap(), 0)),
          samsung: Some(Version::new(NonZeroU16::new(8).unwrap(), 0)),
          ..Default::default()
        },
        ..Default::default()
      },
      _ => todo!(),
    }
  }
}

impl Engines {
  pub fn from_browserslist(browserslist: &str, output_format: OutputFormat) -> Engines {
    let browsers = if output_format == OutputFormat::Esmodule {
      // If the output format is esmodule, exclude browsers
      // that support them natively so that we transpile less.
      browserslist::resolve(
        std::iter::once(browserslist).chain(ESMODULE_BROWSERS.iter().map(|s| *s)),
        &Default::default(),
      )
    } else {
      browserslist::resolve(std::iter::once(browserslist), &Default::default())
    };

    Engines {
      browsers: browsers.map(|b| b.into()).unwrap_or_default(),
      electron: None,
      node: None,
      parcel: None,
    }
  }

  pub fn supports(&self, feature: EnvironmentFeature) -> bool {
    let min = feature.engines();
    macro_rules! check {
      ($p: ident$(. $x: ident)*) => {{
        if let Some(v) = self.$p$(.$x)* {
          match min.$p$(.$x)* {
            None => return false,
            Some(v2) if v < v2 => return false,
            _ => {}
          }
        }
      }};
    }

    check!(browsers.android);
    check!(browsers.chrome);
    check!(browsers.edge);
    check!(browsers.firefox);
    check!(browsers.ie);
    check!(browsers.ios_saf);
    check!(browsers.opera);
    check!(browsers.safari);
    check!(browsers.samsung);
    true
  }
}

bitflags! {
  #[derive(Clone, Copy, Hash, Debug, PartialEq, Eq)]
  pub struct EnvironmentFlags: u8 {
    const IS_LIBRARY = 1 << 0;
    const SHOULD_OPTIMIZE = 1 << 1;
    const SHOULD_SCOPE_HOIST = 1 << 2;
  }
}

impl_bitflags_serde!(EnvironmentFlags);

#[derive(PartialEq, Eq, Clone, Copy, Debug, Hash, Serialize_repr, Deserialize_repr)]
#[repr(u8)]
pub enum EnvironmentContext {
  Browser = 0,
  WebWorker = 1,
  ServiceWorker = 2,
  Worklet = 3,
  Node = 4,
  ElectronMain = 5,
  ElectronRenderer = 6,
}

impl EnvironmentContext {
  pub fn is_node(&self) -> bool {
    use EnvironmentContext::*;
    matches!(self, Node | ElectronMain | ElectronRenderer)
  }

  pub fn is_browser(&self) -> bool {
    use EnvironmentContext::*;
    matches!(
      self,
      Browser | WebWorker | ServiceWorker | Worklet | ElectronRenderer
    )
  }

  pub fn is_worker(&self) -> bool {
    use EnvironmentContext::*;
    matches!(self, WebWorker | ServiceWorker)
  }

  pub fn is_electron(&self) -> bool {
    use EnvironmentContext::*;
    matches!(self, ElectronMain | ElectronRenderer)
  }
}

#[derive(PartialEq, Eq, Clone, Copy, Debug, Hash, Serialize_repr, Deserialize_repr)]
#[repr(u8)]
pub enum SourceType {
  Module = 0,
  Script = 1,
}

#[derive(PartialEq, Eq, Clone, Copy, Debug, Hash, Serialize_repr, Deserialize_repr)]
#[repr(u8)]
pub enum OutputFormat {
  Global = 0,
  Commonjs = 1,
  Esmodule = 2,
}

fn env_interner() -> &'static Interner<Environment> {
  static INTERNER: OnceLock<Interner<Environment>> = OnceLock::new();
  INTERNER.get_or_init(|| Interner::new())
}

impl From<Environment> for Interned<Environment> {
  fn from(value: Environment) -> Self {
    env_interner().intern(value)
  }
}

pub fn reset_env_interner() {
  env_interner().clear();
}
