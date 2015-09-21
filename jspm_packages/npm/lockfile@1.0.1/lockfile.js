/* */ 
(function(process) {
  var fs = require("fs");
  var wx = 'wx';
  if (process.version.match(/^v0\.[0-6]/)) {
    var c = require("constants");
    wx = c.O_TRUNC | c.O_CREAT | c.O_WRONLY | c.O_EXCL;
  }
  var os = require("os");
  exports.filetime = 'ctime';
  if (os.platform() == "win32") {
    exports.filetime = 'mtime';
  }
  var debug;
  var util = require("util");
  if (util.debuglog)
    debug = util.debuglog('LOCKFILE');
  else if (/\blockfile\b/i.test(process.env.NODE_DEBUG))
    debug = function() {
      var msg = util.format.apply(util, arguments);
      console.error('LOCKFILE %d %s', process.pid, msg);
    };
  else
    debug = function() {};
  var locks = {};
  function hasOwnProperty(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  }
  process.on('exit', function() {
    debug('exit listener');
    Object.keys(locks).forEach(exports.unlockSync);
  });
  if (/^v0\.[0-8]\./.test(process.version)) {
    debug('uncaughtException, version = %s', process.version);
    process.on('uncaughtException', function H(er) {
      debug('uncaughtException');
      var l = process.listeners('uncaughtException').filter(function(h) {
        return h !== H;
      });
      if (!l.length) {
        try {
          Object.keys(locks).forEach(exports.unlockSync);
        } catch (e) {}
        process.removeListener('uncaughtException', H);
        throw er;
      }
    });
  }
  exports.unlock = function(path, cb) {
    debug('unlock', path);
    delete locks[path];
    fs.unlink(path, function(unlinkEr) {
      cb();
    });
  };
  exports.unlockSync = function(path) {
    debug('unlockSync', path);
    try {
      fs.unlinkSync(path);
    } catch (er) {}
    delete locks[path];
  };
  exports.check = function(path, opts, cb) {
    if (typeof opts === 'function')
      cb = opts, opts = {};
    debug('check', path, opts);
    fs.open(path, 'r', function(er, fd) {
      if (er) {
        if (er.code !== 'ENOENT')
          return cb(er);
        return cb(null, false);
      }
      if (!opts.stale) {
        return fs.close(fd, function(er) {
          return cb(er, true);
        });
      }
      fs.fstat(fd, function(er, st) {
        if (er)
          return fs.close(fd, function(er2) {
            return cb(er);
          });
        fs.close(fd, function(er) {
          var age = Date.now() - st[exports.filetime].getTime();
          return cb(er, age <= opts.stale);
        });
      });
    });
  };
  exports.checkSync = function(path, opts) {
    opts = opts || {};
    debug('checkSync', path, opts);
    if (opts.wait) {
      throw new Error('opts.wait not supported sync for obvious reasons');
    }
    try {
      var fd = fs.openSync(path, 'r');
    } catch (er) {
      if (er.code !== 'ENOENT')
        throw er;
      return false;
    }
    if (!opts.stale) {
      try {
        fs.closeSync(fd);
      } catch (er) {}
      return true;
    }
    if (opts.stale) {
      try {
        var st = fs.fstatSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      var age = Date.now() - st[exports.filetime].getTime();
      return (age <= opts.stale);
    }
  };
  var req = 1;
  exports.lock = function(path, opts, cb) {
    if (typeof opts === 'function')
      cb = opts, opts = {};
    opts.req = opts.req || req++;
    debug('lock', path, opts);
    opts.start = opts.start || Date.now();
    if (typeof opts.retries === 'number' && opts.retries > 0) {
      debug('has retries', opts.retries);
      var retries = opts.retries;
      opts.retries = 0;
      cb = (function(orig) {
        return function cb(er, fd) {
          debug('retry-mutated callback');
          retries -= 1;
          if (!er || retries < 0)
            return orig(er, fd);
          debug('lock retry', path, opts);
          if (opts.retryWait)
            setTimeout(retry, opts.retryWait);
          else
            retry();
          function retry() {
            opts.start = Date.now();
            debug('retrying', opts.start);
            exports.lock(path, opts, cb);
          }
        };
      })(cb);
    }
    fs.open(path, wx, function(er, fd) {
      if (!er) {
        debug('locked', path, fd);
        locks[path] = fd;
        return fs.close(fd, function() {
          return cb();
        });
      }
      if (er.code !== 'EEXIST')
        return cb(er);
      if (!opts.stale)
        return notStale(er, path, opts, cb);
      return maybeStale(er, path, opts, false, cb);
    });
  };
  function maybeStale(originalEr, path, opts, hasStaleLock, cb) {
    fs.stat(path, function(statEr, st) {
      if (statEr) {
        if (statEr.code === 'ENOENT') {
          opts.stale = false;
          debug('lock stale enoent retry', path, opts);
          exports.lock(path, opts, cb);
          return;
        }
        return cb(statEr);
      }
      var age = Date.now() - st[exports.filetime].getTime();
      if (age <= opts.stale)
        return notStale(originalEr, path, opts, cb);
      debug('lock stale', path, opts);
      if (hasStaleLock) {
        exports.unlock(path, function(er) {
          if (er)
            return cb(er);
          debug('lock stale retry', path, opts);
          fs.link(path + '.STALE', path, function(er) {
            fs.unlink(path + '.STALE', function() {
              cb(er);
            });
          });
        });
      } else {
        debug('acquire .STALE file lock', opts);
        exports.lock(path + '.STALE', opts, function(er) {
          if (er)
            return cb(er);
          maybeStale(originalEr, path, opts, true, cb);
        });
      }
    });
  }
  function notStale(er, path, opts, cb) {
    debug('notStale', path, opts);
    if (typeof opts.wait !== 'number' || opts.wait <= 0)
      return cb(er);
    var now = Date.now();
    var start = opts.start || now;
    var end = start + opts.wait;
    if (end <= now)
      return cb(er);
    debug('now=%d, wait until %d (delta=%d)', start, end, end - start);
    var wait = Math.min(end - start, opts.pollPeriod || 100);
    var timer = setTimeout(poll, wait);
    function poll() {
      debug('notStale, polling', path, opts);
      exports.lock(path, opts, cb);
    }
  }
  exports.lockSync = function(path, opts) {
    opts = opts || {};
    opts.req = opts.req || req++;
    debug('lockSync', path, opts);
    if (opts.wait || opts.retryWait) {
      throw new Error('opts.wait not supported sync for obvious reasons');
    }
    try {
      var fd = fs.openSync(path, wx);
      locks[path] = fd;
      try {
        fs.closeSync(fd);
      } catch (er) {}
      debug('locked sync!', path, fd);
      return;
    } catch (er) {
      if (er.code !== 'EEXIST')
        return retryThrow(path, opts, er);
      if (opts.stale) {
        var st = fs.statSync(path);
        var ct = st[exports.filetime].getTime();
        if (!(ct % 1000) && (opts.stale % 1000)) {
          opts.stale = 1000 * Math.ceil(opts.stale / 1000);
        }
        var age = Date.now() - ct;
        if (age > opts.stale) {
          debug('lockSync stale', path, opts, age);
          exports.unlockSync(path);
          return exports.lockSync(path, opts);
        }
      }
      debug('failed to lock', path, opts, er);
      return retryThrow(path, opts, er);
    }
  };
  function retryThrow(path, opts, er) {
    if (typeof opts.retries === 'number' && opts.retries > 0) {
      var newRT = opts.retries - 1;
      debug('retryThrow', path, opts, newRT);
      opts.retries = newRT;
      return exports.lockSync(path, opts);
    }
    throw er;
  }
})(require("process"));