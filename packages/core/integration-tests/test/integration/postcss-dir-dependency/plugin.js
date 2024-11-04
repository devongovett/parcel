module.exports = (opts = {}) => {
  const glob = require('fast-glob');
  const fs = require('fs');
  const path = require('path')

  return {
    postcssPlugin: 'postcss-test',
    Once(root, {result}) {
      root.walkRules((rule) => {
        rule.each((decl) => {
          if (decl.value === 'bg-glob') {
            decl.value = glob.sync('backgrounds/*.txt', {cwd: __dirname}).sort().map(f => fs.readFileSync(path.join(__dirname, f))).join(', ');
            result.messages.push({
              type: 'dir-dependency',
              dir: __dirname + '/backgrounds',
              glob: '*.txt'
            });
          }
        });
      });
    },
  };
};
module.exports.postcss = true;
