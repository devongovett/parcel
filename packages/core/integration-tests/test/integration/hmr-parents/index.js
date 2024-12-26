require('./middle');

output('root');
module.hot.accept(() => {
  output('accept root');
});
