/* JXA regression tests with a fake Music application; never send Apple Events. */
ObjC.import('Foundation');

function run(args) {
  var source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null));
  // Evaluate the real collector with injected application/framework dependencies.
  var evaluate = new Function('Application', 'ObjC', 'config', source + '\nreturn music(config);');
  var passed = 0;
  function failure() { throw new Error("Can't get object (-1728)."); }
  function fixture(state) {
    return {
      running: function () { return true; },
      playerState: function () { return state; },
      currentTrack: function () {
        return { name: function () { return '星晴 🌌'; }, artist: function () { return '周杰伦'; } };
      }
    };
  }
  function check(name, player, expected, enabled) {
    var applicationAccesses = 0;
    var actual = evaluate(function (applicationName) {
      applicationAccesses += 1;
      if (applicationName !== 'Music') throw new Error('Unexpected application access.');
      if (enabled === false) throw new Error('Disabled music must not access an application.');
      return player;
    }, { import: function () {} }, { privacy: { music: enabled !== false } });
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(name + ': ' + JSON.stringify(actual));
    }
    if (enabled === false && applicationAccesses !== 0) {
      throw new Error('Disabled music accessed an application.');
    }
    passed += 1;
  }
  ['playing', 'paused'].forEach(function (state) {
    check(state + ' with metadata', fixture(state), { state: state, track: '星晴 🌌', artist: '周杰伦' });
    var missingTrack = fixture(state);
    missingTrack.currentTrack = failure;
    check(state + ' without track object', missingTrack, { state: state, track: null, artist: null });
  });
  var missingName = fixture('paused');
  missingName.currentTrack = function () { return { name: failure, artist: function () { return '周杰伦'; } }; };
  check('name failure retains artist', missingName, { state: 'paused', track: null, artist: '周杰伦' });
  var missingArtist = fixture('playing');
  missingArtist.currentTrack = function () { return { name: function () { return '星晴 🌌'; }, artist: failure }; };
  check('artist failure retains name', missingArtist, { state: 'playing', track: '星晴 🌌', artist: null });
  var missingBoth = fixture('paused');
  missingBoth.currentTrack = function () { return { name: failure, artist: failure }; };
  check('both fields fail without losing state', missingBoth, { state: 'paused', track: null, artist: null });
  var denied = fixture('playing');
  denied.playerState = function () { throw new Error('Not authorized to send Apple events (-1743).'); };
  check('state permission denied', denied, { state: 'unavailable', track: null, artist: null });
  var stopped = fixture('stopped');
  stopped.currentTrack = failure;
  check('stopped does not require metadata', stopped, { state: 'stopped', track: null, artist: null });
  var closed = fixture('playing');
  closed.running = function () { return false; };
  closed.playerState = failure;
  check('closed app is not queried or launched', closed, { state: 'stopped', track: null, artist: null });
  check('privacy disabled', null, { state: 'unavailable', track: null, artist: null }, false);
  return JSON.stringify({ passed: passed });
}
