var a, b, c, d, e, f, g, h, x, y, z;
a = 1 + 2 * 3 / 5;
b = (1 + 2) * 3 / 5;
c = (1 + 2) * (3 - 5);
d = x | y ^ z;
e = (x | y) ^ z;
f = "a" + (1 + 2) + "b";
g = "a" + (1 - 2) + "b";
a = true || false && null;
b = c == d || e != f;
c = x instanceof y || x instanceof z;
d = x == y && y != z;
a = !false;
b = !x instanceof Number;
c = !(x instanceof Number);
d = typeof a === 'boolean';
e = !(typeof a) === 'boolean';
f = !(typeof a === 'boolean');
a = (1.1).toString();
b = new A().toString();
c = new x.A().toString();
d = new x.y().z();
var r = (/ab+c/i).exec('abc');
a = b ** 2 * 3;
c = (d ** 2) ** 3;
e = f ** 2 ** 3;
e = (+2) ** 3;
e = 2 ** +3;
f = a + (b = 3);
g = 1 && (() => {});
g = (() => {}) && 1;
h = (10, +(+15));
a = -(--i);
