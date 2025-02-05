const f = () => import("./b.js");

global.output = f;
