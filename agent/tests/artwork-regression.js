/* Native JXA fixtures: no Music events or network requests are sent. */
ObjC.import('Foundation');

function run(args) {
  var source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null));
  var pure = new Function(source + '\nreturn {match:artworkMatch,safe:artworkSafeUrl,normalize:artworkNormalized,cache:artworkCacheValue};')();
  var enrich = new Function('Application', 'input', 'cachePath', 'temporary', 'enabled',
    source + '\nreturn enrichArtwork(input, cachePath, temporary, enabled);');
  var root = args[1], cachePath = root + '/artwork-cache.json', passed = 0, calls = 0;
  var artwork = 'https://is1-ssl.mzstatic.com/image/thumb/Music/test/100x100bb.jpg';
  var trackUrl = 'https://music.apple.com/us/album/example/123?i=456';
  var candidate = { kind: 'song', trackName: ' Ａ Song ', artistName: 'Example   Artist',
    artworkUrl100: artwork, trackViewUrl: trackUrl };
  var response = { results: [candidate] }, httpStatus = '200', networkError = false;
  function check(condition, label) { if (!condition) throw new Error(label); passed += 1; }
  function write(path, value) {
    $(value).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
  }
  function read(path) {
    return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null));
  }
  function removeCache() { $.NSFileManager.defaultManager.removeItemAtPathError(cachePath, null); }
  var application = { currentApplication: function () { return { doShellScript: function (command) {
    calls += 1;
    check(command.indexOf('/usr/bin/curl -q --config ') === 0 && command.indexOf('Song') < 0,
      'curl argv must only expose the config path');
    var config = read(root + '/artwork-curl.conf');
    check(config.indexOf('Authorization') < 0 && config.indexOf('Bearer') < 0 &&
      config.indexOf('max-time = 5') >= 0 && config.indexOf('max-filesize = 131072') >= 0 &&
      config.indexOf('location') < 0 && config.indexOf('retry') < 0 &&
      config.indexOf('&entity=song&country=us&limit=5') >= 0, 'private, bounded, fixed Apple query');
    if (networkError) throw new Error('Simulated offline or oversized response.');
    write(root + '/artwork-response.json', typeof response === 'string' ? response : JSON.stringify(response));
    return httpStatus;
  } }; } };
  var input = { state: 'playing', track: 'A Song', artist: 'Example Artist' };
  function collect(value, enabled) { return enrich(application, value || input, cachePath, root, enabled !== false); }

  check(pure.normalize('  Ａ\u00a0 Song  ') === 'a song', 'NFKC, whitespace and case normalization');
  check(pure.match({ results: [candidate] }, 'a song', 'example artist').artwork_url === artwork, 'exact normalized match');
  check(pure.match({ results: [candidate] }, 'another song', 'example artist') === null, 'different track rejected');
  check(pure.match({ results: [candidate] }, 'a song', 'another artist') === null, 'different artist rejected');
  var censored = Object.assign({}, candidate, { trackName: 'Different', trackCensoredName: 'A Song' });
  check(pure.match({ results: [censored] }, 'a song', 'example artist') !== null, 'censored Apple name is supported');
  check(pure.match({ results: [{}, {}, {}, {}, {}, candidate] }, 'a song', 'example artist') === null, 'only first five results');
  ['http://is1.mzstatic.com/x', 'https://mzstatic.com/x', 'https://is1.mzstatic.com.evil.test/x',
    'https://user@is1.mzstatic.com/x', 'https://is1.mzstatic.com:443/x', 'https://is1.mzstatic.com/x\n',
    'https://is1.mzstatic.com\\@evil.test/x', 'https://is1.mzstatic.com/' + Array(2050).join('a')].forEach(function (url) {
    check(!pure.safe(url, true), 'unsafe artwork URL rejected');
  });
  check(pure.safe(trackUrl, false) && pure.safe('https://itunes.apple.com/us/album/x/1', false), 'official track hosts');
  check(!pure.safe('https://sub.music.apple.com/x', false) && !pure.safe('https://music.apple.com:443/x', false), 'track host and port exact');
  var unsafe = Object.assign({}, candidate, { trackViewUrl: 'https://example.com/song' });
  check(pure.match({ results: [unsafe] }, 'a song', 'example artist') === null, 'both URLs must be safe together');

  removeCache();
  var enriched = collect();
  check(enriched.artwork_url === artwork && enriched.track_url === trackUrl && enriched.state === 'playing', 'successful enrichment');
  var record = JSON.parse(read(cachePath));
  check(record.expires_at - record.cached_at === 3600000, 'success lifetime is one hour');
  var before = calls;
  check(collect({ state: 'paused', track: 'Ａ Song', artist: 'Example  Artist' }).artwork_url === artwork && calls === before,
    'same normalized paused track reuses cache');
  check(pure.cache(record, record.key, record.expires_at) === undefined &&
    pure.cache(record, record.key, record.cached_at - 1) === undefined, 'expiry and future cache rejected');
  response = { results: [] };
  var changed = collect({ state: 'playing', track: 'New Song', artist: 'Example Artist' });
  check(changed.track === 'New Song' && !('artwork_url' in changed) && calls === before + 1, 'new song never reuses stale image');
  record = JSON.parse(read(cachePath));
  check(record.expires_at - record.cached_at === 300000 && record.value === null && record.key.indexOf('new song') >= 0,
    'negative cache replaces old song for five minutes');
  before = calls;
  collect({ state: 'playing', track: 'New Song', artist: 'Example Artist' });
  check(calls === before, 'negative cache prevents repeat search');
  ['stopped', 'unavailable'].forEach(function (state) {
    write(cachePath, JSON.stringify(record));
    var value = collect({ state: state, track: null, artist: null });
    check(!('artwork_url' in value) && !$.NSFileManager.defaultManager.fileExistsAtPath(cachePath) && calls === before,
      'inactive music clears cache without lookup');
  });
  write(cachePath, JSON.stringify(record));
  collect(input, false);
  check(!$.NSFileManager.defaultManager.fileExistsAtPath(cachePath) && calls === before, 'disabled privacy clears cache without lookup');
  write(cachePath, JSON.stringify(record));
  collect({ state: 'paused', track: 'A Song', artist: null });
  check(!$.NSFileManager.defaultManager.fileExistsAtPath(cachePath) && calls === before, 'missing metadata clears cache');
  response = { results: [candidate] }; networkError = true;
  check(!('artwork_url' in collect()), 'network failure preserves music without URLs');
  networkError = false; removeCache(); httpStatus = '302';
  check(!('artwork_url' in collect()), 'redirect body cannot supply artwork');
  httpStatus = '200'; removeCache(); response = '{malformed';
  check(!('artwork_url' in collect()), 'malformed JSON fails closed');
  removeCache(); response = Array(131074).join(' ');
  check(!('artwork_url' in collect()), 'oversized body fails closed');
  removeCache(); response = { results: [candidate] };
  collect();
  return JSON.stringify({ passed: passed, requests: calls });
}
