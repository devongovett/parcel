const resolve = require('resolve');
const path = require('path');

function resolveSource(specifier, from) {
  return resolve.sync(specifier, {
    basedir: path.dirname(from),
    packageFilter(pkg) {
      if (pkg.name.startsWith('@parcel/') && pkg.name !== '@parcel/watcher') {
        if (pkg.source) {
          pkg.main = pkg.source;
        }
        if (pkg.exports?.source) {
          pkg.main = pkg.exports.source;
        }
      }
      return pkg;
    },
  });
}

let sourceFieldCache = new Map();
function getSourceField(specifier, from) {
  let key = `${specifier}:${from}`;
  if (sourceFieldCache.has(key)) {
    return sourceFieldCache.get(key);
  }

  let result = resolveSource(specifier, from);
  sourceFieldCache.set(key, result);
  return result;
}

module.exports = ({types: t}) => ({
  name: 'module-translate',
  visitor: {
    ImportDeclaration({node}, state) {
      let source = node.source;
      if (t.isStringLiteral(source) && source.value.startsWith('@parcel/')) {
        source.value = getSourceField(
          source.value,
          state.file.opts.filename || process.cwd(),
        );
      }
    },
    CallExpression(path, state) {
      let {node} = path;
      if (
        t.isIdentifier(node.callee, {name: 'require'}) &&
        !path.scope.hasBinding(node.callee.value) &&
        node.arguments.length === 1 &&
        t.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].value.startsWith('@parcel/')
      ) {
        try {
          node.arguments[0].value = getSourceField(
            node.arguments[0].value,
            state.file.opts.filename || process.cwd(),
          );
        } catch (e) {
          let exprStmtParent = path
            .getAncestry()
            .find(v => v.isExpressionStatement());
          if (exprStmtParent) {
            exprStmtParent.replaceWith(
              t.throwStatement(t.stringLiteral(e.message)),
            );
          }
        }
      }
    },
  },
});

module.exports.resolveSource = resolveSource;
