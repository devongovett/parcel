const {isComponent, flush} = require('@prefresh/utils');

const NAMESPACE = '__PREFRESH__';

const getExports = m => m.exports || m.__proto__.exports;
window.$flush = flush;

function isSafeExport(key) {
  return (
    key === '__esModule' ||
    key === '__N_SSG' ||
    key === '__N_SSP' ||
    key === '__N_RSC' ||
    key === 'config'
  );
}

function registerExports(moduleExports, moduleId) {
  self[NAMESPACE].register(moduleExports, moduleId + ' %exports%');
  if (moduleExports == null || typeof moduleExports !== 'object') return;

  for (const key in moduleExports) {
    if (isSafeExport(key)) continue;
    const exportValue = moduleExports[key];
    const typeID = moduleId + ' %exports% ' + key;
    self[NAMESPACE].register(exportValue, typeID);
  }
}

const shouldBind = m => {
  let isCitizen = false;
  const moduleExports = getExports(m);

  if (isComponent(moduleExports)) {
    isCitizen = true;
  }

  if (
    moduleExports === undefined ||
    moduleExports === null ||
    typeof moduleExports !== 'object'
  ) {
    isCitizen = isCitizen || false;
  } else {
    for (const key in moduleExports) {
      if (key === '__esModule') continue;

      const exportValue = moduleExports[key];
      if (isComponent(exportValue)) {
        isCitizen = isCitizen || true;
      }
    }
  }

  return isCitizen;
};

module.exports.prelude = function (m) {
  window.$RefreshSig$ = function () {
    let status = 'begin';
    let savedType;
    return function (type, key, forceReset, getCustomHooks) {
      if (!savedType) savedType = type;
      status = self[NAMESPACE].sign(
        type || savedType,
        key,
        forceReset,
        getCustomHooks,
        status,
      );
    };
  };

  window.$RefreshReg$ = function (type, id) {
    self[NAMESPACE].register(type, m.id + ' ' + id);
  };
};

module.exports.postlude = function (m) {
  const isPrefreshComponent = shouldBind(m);

  if (m.hot) {
    const currentExports = getExports(m);
    const previousHotModuleExports = m.hot.data && m.hot.data.moduleExports;

    registerExports(currentExports, m.id);

    if (isPrefreshComponent) {
      if (previousHotModuleExports) {
        try {
          flush();
          if (
            typeof __prefresh_errors__ !== 'undefined' &&
            __prefresh_errors__ &&
            __prefresh_errors__.clearRuntimeErrors
          ) {
            __prefresh_errors__.clearRuntimeErrors();
          }
        } catch (e) {
          if (m.hot.invalidate) {
            m.hot.invalidate();
          } else {
            self.location.reload();
          }
        }
      }

      m.hot.dispose(function (data) {
        data.moduleExports = getExports(m);
      });

      m.hot.accept(function (getParents) {
        if (
          typeof __prefresh_errors__ !== 'undefined' &&
          __prefresh_errors__ &&
          __prefresh_errors__.handleRuntimeError
        ) {
          __prefresh_errors__.handleRuntimeError(error);
        }
        flush();
      });
    }
  }
};
