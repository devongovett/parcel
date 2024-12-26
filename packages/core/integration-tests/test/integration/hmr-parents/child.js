const updated = require('./updated');

output('child ' + updated.a);
module.hot.accept(getParents => {
  output('accept child');
  return getParents();
});
