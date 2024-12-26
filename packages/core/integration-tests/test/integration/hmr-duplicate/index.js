let a = import('./a');
let b = import('./b');

function run() {
  a.then(function (a) {
    b.then(function (b) {
      output(a.a + b.a);
    });
  });
};

module.hot.accept();

run();
