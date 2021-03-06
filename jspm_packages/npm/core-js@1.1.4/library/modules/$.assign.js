/* */ 
var toObject = require("./$.to-object"),
    IObject = require("./$.iobject"),
    enumKeys = require("./$.enum-keys");
module.exports = require("./$.fails")(function() {
  return Symbol() in Object.assign({});
}) ? function assign(target, source) {
  var T = toObject(target),
      l = arguments.length,
      i = 1;
  while (l > i) {
    var S = IObject(arguments[i++]),
        keys = enumKeys(S),
        length = keys.length,
        j = 0,
        key;
    while (length > j)
      T[key = keys[j++]] = S[key];
  }
  return T;
} : Object.assign;
