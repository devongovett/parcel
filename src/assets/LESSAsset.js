const Asset = require('../Asset');
const localRequire = require('../utils/localRequire');
const promisify = require('../utils/promisify');
const getLessFileManager = require('../visitors/lessFileManager');

class LESSAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'css';
  }

  async parse(code) {
    // less should be installed locally in the module that's being required
    let less = await localRequire('less', this.name);
    let render = promisify(less.render.bind(less));

    let opts =
      (await this.getConfig(['.lessrc', '.lessrc.js'], {packageKey: 'less'})) ||
      {};
    opts.filename = this.name;
    opts.plugins = (opts.plugins || []).concat(urlPlugin(this));

    return await render(code, opts);
  }

  collectDependencies() {
    for (let dep of this.ast.imports) {
      this.addDependency(dep, {includedInParent: true});
    }
  }

  generate() {
    return [
      {
        type: 'css',
        value: this.ast ? this.ast.css : '',
        hasDependencies: false
      }
    ];
  }
}

function urlPlugin(asset) {
  return {
    install: (less, pluginManager) => {
      let visitor = new less.visitors.Visitor({
        visitUrl: node => {
          node.value.value = asset.addURLDependency(
            node.value.value,
            node.currentFileInfo.filename
          );
          return node;
        }
      });

      visitor.run = visitor.visit;
      pluginManager.addVisitor(visitor);

      let lessFileManager = getLessFileManager(less, asset.options);
      pluginManager.addFileManager(new lessFileManager());
    }
  };
}

module.exports = LESSAsset;
