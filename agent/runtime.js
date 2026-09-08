/* Native JavaScript for Automation runtime. Run with /usr/bin/osascript. */
ObjC.import('Foundation');

var DEFAULT_BLOCKLIST = [
  '1Password', '1Password 7', '1Password 8', 'Bitwarden', 'Dashlane',
  'KeePassXC', 'LastPass', 'Keychain Access', 'Passwords', 'SecurityAgent',
  'System Settings', 'System Preferences', 'UserNotificationCenter'
];
var BLOCKED_BUNDLE_PREFIXES = [
  'com.apple.passwords', 'com.apple.systempreferences', 'com.apple.keychainaccess',
  'com.apple.securityagent', 'com.apple.usernotificationcenter', 'com.agilebits.onepassword', 'com.1password',
  'com.bitwarden.desktop', 'com.keepassxc.keepassxc', 'org.keepassxc.keepassxc',
  'com.dashlane', 'com.lastpass'
];
var PRIVACY_FIELDS = ['active_app', 'running_apps', 'battery', 'system', 'music'];
var PROFILES = {
  buffered: { interval_seconds: 300, status_ttl_seconds: 600 },
  eco: { interval_seconds: 120, status_ttl_seconds: 180 },
  realtime: { interval_seconds: 30, status_ttl_seconds: 60 }
};

function profile(value) {
  if (value !== 'buffered' && value !== 'eco' && value !== 'realtime') {
    throw new Error('profile must be buffered, eco or realtime.');
  }
  return value;
}

function readText(path, optional) {
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(path)) {
    if (optional) return null;
    throw new Error('Required local file is missing.');
  }
  var value = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null);
  if (!value || value.isNil()) throw new Error('Cannot read local UTF-8 file.');
  return ObjC.unwrap(value);
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuration(path) {
  var raw = readText(path, true);
  var input = raw === null ? {} : JSON.parse(raw);
  if (!object(input)) throw new Error('Configuration must be a JSON object.');
  Object.keys(input).forEach(function (key) {
    if (['endpoint', 'profile', 'privacy', 'blocked_apps'].indexOf(key) < 0) {
      throw new Error('Unrecognized configuration key.');
    }
  });
  // Existing configurations predate profiles and must retain their 30-second cadence.
  var result = { endpoint: '', profile: raw === null ? 'buffered' : 'realtime', privacy: {}, blocked_apps: [] };
  if (input.profile !== undefined) result.profile = profile(input.profile);
  if (input.endpoint !== undefined) {
    if (typeof input.endpoint !== 'string') throw new Error('endpoint must be a string.');
    result.endpoint = input.endpoint;
  }
  if (input.privacy !== undefined && !object(input.privacy)) {
    throw new Error('privacy must be an object.');
  }
  Object.keys(input.privacy || {}).forEach(function (field) {
    if (PRIVACY_FIELDS.indexOf(field) < 0) throw new Error('Unrecognized privacy field.');
  });
  PRIVACY_FIELDS.forEach(function (field) {
    var value = (input.privacy || {})[field];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error('Privacy controls must be true or false.');
    }
    result.privacy[field] = value === undefined ? true : value;
  });
  if (input.blocked_apps !== undefined) {
    if (!Array.isArray(input.blocked_apps) || input.blocked_apps.length > 128) {
      throw new Error('blocked_apps must contain at most 128 application names.');
    }
    input.blocked_apps.forEach(function (name) {
      if (typeof name !== 'string' || !name.trim() || name.length > 200) {
        throw new Error('Each blocked application name must contain 1 to 200 characters.');
      }
    });
    result.blocked_apps = input.blocked_apps;
  }
  return result;
}

function endpoint(value) {
  // Keep the endpoint an origin: no URL credentials, query, fragment, or custom path.
  var secure = /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/?$/;
  var local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/;
  if (!secure.test(value) && !local.test(value)) {
    throw new Error('endpoint must be an HTTPS origin (HTTP is allowed only for loopback testing).');
  }
  return value.replace(/\/$/, '');
}

function token(path) {
  var value = readText(path, false).trim();
  if (value.length < 32 || value.length > 512 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(value)) {
    throw new Error('Token must contain 32 to 512 valid Bearer-token characters.');
  }
  return value;
}

function cleanString(value, maximum) {
  if (value === null || value === undefined) return null;
  var text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  // Array.from preserves surrogate pairs when clipping Unicode strings.
  text = Array.from(text).slice(0, maximum).join('');
  return text;
}

function blocked(name, bundleID, config) {
  var candidate = String(name || '').trim().toLowerCase();
  var bundle = String(bundleID || '').toLowerCase();
  return BLOCKED_BUNDLE_PREFIXES.some(function (prefix) {
    return bundle === prefix || bundle.indexOf(prefix + '.') === 0;
  }) || DEFAULT_BLOCKLIST.concat(config.blocked_apps).some(function (entry) {
    return candidate === entry.trim().toLowerCase();
  });
}

function unavailableMusic() {
  return { state: 'unavailable', track: null, artist: null };
}

function collect(config) {
  var result = {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    active_app: null,
    battery: { percent: null, charging: null, power_source: 'unknown' },
    system: { load_1m: null, load_5m: null, load_15m: null },
    music: unavailableMusic()
  };
  if (config.privacy.active_app || config.privacy.running_apps) {
    try {
      ObjC.import('AppKit');
      var workspace = $.NSWorkspace.sharedWorkspace;
      if (config.privacy.active_app) {
        var frontApp = workspace.frontmostApplication;
        var front = ObjC.unwrap(frontApp.localizedName);
        var frontBundle = ObjC.unwrap(frontApp.bundleIdentifier);
        result.active_app = blocked(front, frontBundle, config) ? 'System' : cleanString(front, 200);
      }
      if (config.privacy.running_apps) {
        var names = [];
        ObjC.unwrap(workspace.runningApplications).forEach(function (app) {
          // Visible GUI applications only. Never inspect process arguments or window titles.
          if (Number(app.activationPolicy) !== 0) return;
          var rawName = ObjC.unwrap(app.localizedName);
          if (blocked(rawName, ObjC.unwrap(app.bundleIdentifier), config)) return;
          var name = cleanString(rawName, 200);
          if (name && names.indexOf(name) < 0) names.push(name);
        });
        result.running_apps = names.sort().slice(0, 64);
      }
    } catch (_) {
      if (config.privacy.running_apps) result.running_apps = [];
    }
  }
  var shell = Application.currentApplication();
  shell.includeStandardAdditions = true;
  if (config.privacy.battery) {
    try {
      var battery = shell.doShellScript('/usr/bin/pmset -g batt');
      var percent = battery.match(/(-?\d+)%;/);
      var hasBattery = percent !== null && Number(percent[1]) >= 0 && Number(percent[1]) <= 100;
      result.battery.percent = hasBattery ? Number(percent[1]) : null;
      result.battery.power_source = /AC Power/.test(battery) ? 'ac' :
        (/Battery Power/.test(battery) ? 'battery' : 'unknown');
      result.battery.charging = hasBattery ? /;\s*charging;/.test(battery) : null;
    } catch (_) {}
  }
  if (config.privacy.system) {
    try {
      var loads = shell.doShellScript('/usr/sbin/sysctl -n vm.loadavg').match(/[0-9]+(?:\.[0-9]+)?/g);
      if (loads && loads.length >= 3) {
        ['load_1m', 'load_5m', 'load_15m'].forEach(function (key, index) {
          var value = Number(loads[index]);
          result.system[key] = isFinite(value) && value >= 0 && value <= 100000 ? value : null;
        });
      }
    } catch (_) {}
  }
  return result;
}

function music(config) {
  if (!config.privacy.music) return unavailableMusic();
  try {
    var player = Application('Music');
    // running() checks the process without sending an event that launches Music.
    if (!player.running()) return { state: 'stopped', track: null, artist: null };
    var state = String(player.playerState());
    if (state !== 'playing' && state !== 'paused') {
      return { state: 'stopped', track: null, artist: null };
    }
    var result = { state: state, track: null, artist: null };
    var track;
    // Music can expose playerState while its current track is missing (-1728).
    // Preserve that known state and degrade each metadata field independently.
    try { track = player.currentTrack(); } catch (_) { return result; }
    try { result.track = cleanString(track.name(), 500); } catch (_) {}
    try { result.artist = cleanString(track.artist(), 500); } catch (_) {}
    return result;
  } catch (_) {
    return unavailableMusic();
  }
}

function xml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

var ARTWORK_SUCCESS_MS = 60 * 60 * 1000;
var ARTWORK_EMPTY_MS = 5 * 60 * 1000;
var ARTWORK_MAX_BYTES = 128 * 1024;

function artworkNormalized(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function artworkSafeUrl(value, image) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  // Parse a deliberately narrow HTTPS authority: no credentials or explicit port.
  var match = /^https:\/\/([a-zA-Z0-9.-]+)(?:[/?#]|$)/.exec(value);
  if (!match || !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/.test(match[1])) return false;
  var host = match[1].toLowerCase();
  return image ? host.length > '.mzstatic.com'.length && host.slice(-'.mzstatic.com'.length) === '.mzstatic.com'
    : host === 'itunes.apple.com' || host === 'music.apple.com';
}

function artworkMatch(body, track, artist) {
  if (!body || !Array.isArray(body.results)) return null;
  for (var index = 0; index < Math.min(body.results.length, 5); index += 1) {
    var candidate = body.results[index];
    if (!candidate || candidate.kind !== 'song' || artworkNormalized(candidate.artistName) !== artist ||
      [candidate.trackName, candidate.trackCensoredName].every(function (name) { return artworkNormalized(name) !== track; }) ||
      !artworkSafeUrl(candidate.artworkUrl100, true) || !artworkSafeUrl(candidate.trackViewUrl, false)) continue;
    return { artwork_url: candidate.artworkUrl100, track_url: candidate.trackViewUrl };
  }
  return null;
}

function artworkCacheValue(record, key, now) {
  if (!object(record) || record.version !== 1 || record.key !== key ||
    !Number.isSafeInteger(record.cached_at) || !Number.isSafeInteger(record.expires_at) ||
    now < record.cached_at || now >= record.expires_at) return undefined;
  var value = record.value;
  var lifetime = value === null ? ARTWORK_EMPTY_MS : ARTWORK_SUCCESS_MS;
  if (record.expires_at - record.cached_at !== lifetime) return undefined;
  if (value !== null && (!object(value) || !artworkSafeUrl(value.artwork_url, true) ||
    !artworkSafeUrl(value.track_url, false))) return undefined;
  return value === null ? null : { artwork_url: value.artwork_url, track_url: value.track_url };
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function writePrivateText(path, value) {
  if (!$(value).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null)) {
    throw new Error('Could not write private artwork data.');
  }
  if (!$.NSFileManager.defaultManager.setAttributesOfItemAtPathError($({NSFilePosixPermissions: 384}), path, null)) {
    throw new Error('Could not protect private artwork data.');
  }
}

function enrichArtwork(music, cachePath, temporary, enabled) {
  var result = { state: music.state, track: music.track, artist: music.artist };
  var track = artworkNormalized(music.track), artist = artworkNormalized(music.artist);
  if (!enabled || ['playing', 'paused'].indexOf(music.state) < 0 || !track || !artist) {
    $.NSFileManager.defaultManager.removeItemAtPathError(cachePath, null);
    return result;
  }
  var key = JSON.stringify([track, artist]), now = Date.now(), value;
  try { value = artworkCacheValue(JSON.parse(readText(cachePath, true)), key, now); } catch (_) {}
  if (value === undefined) {
    // Remove the old song before searching; only one current-song record is retained.
    $.NSFileManager.defaultManager.removeItemAtPathError(cachePath, null);
    value = null;
    var responsePath = temporary + '/artwork-response.json';
    var curlPath = temporary + '/artwork-curl.conf';
    var url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(music.track.trim() + ' ' + music.artist.trim()) +
      '&entity=song&country=us&limit=5';
    try {
      writePrivateText(curlPath, [
        'url = ' + JSON.stringify(url),
        'request = "GET"', 'connect-timeout = 3', 'max-time = 5',
        'max-filesize = ' + ARTWORK_MAX_BYTES, 'max-redirs = 0', 'proto = "=https"',
        'silent', 'show-error', 'fail', 'output = ' + JSON.stringify(responsePath),
        'write-out = "%{http_code}"'
      ].join('\n'));
      var shell = Application.currentApplication();
      shell.includeStandardAdditions = true;
      var status = shell.doShellScript('/usr/bin/curl -q --config ' + shellQuote(curlPath) + ' 2>/dev/null');
      if (status === '200') {
        var raw = readText(responsePath, false);
        if (Number($(raw).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding)) <= ARTWORK_MAX_BYTES) {
          value = artworkMatch(JSON.parse(raw), track, artist);
        }
      }
    } catch (_) {
      // Apple errors are optional metadata failures, never a failed status upload.
    }
    var cachedAt = Date.now();
    try {
      writePrivateText(cachePath, JSON.stringify({ version: 1, key: key, cached_at: cachedAt,
        expires_at: cachedAt + (value ? ARTWORK_SUCCESS_MS : ARTWORK_EMPTY_MS), value: value }));
    } catch (_) {}
  }
  if (value) {
    result.artwork_url = value.artwork_url;
    result.track_url = value.track_url;
  }
  return result;
}

function run(args) {
  var command = args[0];
  if (command === 'profile') return configuration(args[1]).profile;
  if (command === 'collect') return JSON.stringify(collect(configuration(args[1])));
  if (command === 'music') return JSON.stringify(music(configuration(args[1])));
  if (command === 'artwork') {
    return JSON.stringify(enrichArtwork(JSON.parse(readText(args[1], false)), args[2], args[3], configuration(args[4]).privacy.music));
  }
  if (command === 'merge') {
    var data = JSON.parse(readText(args[1], false));
    try { data.music = JSON.parse(readText(args[2], false)); } catch (_) {}
    // Leave headroom below the gateway's 16 KiB limit even with long Unicode app names.
    while (data.running_apps && data.running_apps.length &&
      Number($(JSON.stringify(data)).lengthOfBytesUsingEncoding($.NSUTF8StringEncoding)) > 15000) {
      data.running_apps.pop();
    }
    return JSON.stringify(data);
  }
  if (command === 'configure') {
    var config = configuration(args[1]);
    config.endpoint = endpoint(args[2] || config.endpoint);
    if (args[3]) config.profile = profile(args[3]);
    return JSON.stringify(config, null, 2);
  }
  if (command === 'schedule-message') {
    var selectedProfile = configuration(args[1]).profile;
    var schedule = PROFILES[selectedProfile];
    if (selectedProfile === 'buffered') return 'Profile buffered: native event collection, Music reconciliation every 2 seconds, hardware every 30 seconds; upload a 900-second sliding window every 300 seconds to /api/batch.';
    return 'Profile ' + selectedProfile + ': configured to update every ' + schedule.interval_seconds +
      ' seconds; Worker STATUS_TTL_SECONDS must be ' + schedule.status_ttl_seconds + '.';
  }
  if (command === 'validate') {
    endpoint(configuration(args[1]).endpoint);
    token(args[2]);
    return 'Configuration is valid.';
  }
  if (command === 'curl-config') {
    var origin = endpoint(configuration(args[1]).endpoint);
    return [
      'url = ' + JSON.stringify(origin + (args[4] === 'batch' ? '/api/batch' : '/api/update')),
      'header = ' + JSON.stringify('Authorization: Bearer ' + token(args[2])),
      'header = "Content-Type: application/json"',
      'data-binary = ' + JSON.stringify('@' + args[3]),
      'connect-timeout = 5',
      'max-time = 12',
      'max-redirs = 0',
      'proto = ' + JSON.stringify(origin.indexOf('https:') === 0 ? '=https' : '=http'),
      'silent', 'show-error', 'fail', 'output = "/dev/null"',
      'write-out = "%{http_code}"'
    ].join('\n');
  }
  if (command === 'result') {
    return JSON.stringify({
      last_attempt: new Date().toISOString(),
      success: args[1] === '0' && /^2[0-9]{2}$/.test(args[2]),
      curl_exit_code: Number(args[1]),
      http_status: /^[0-9]{3}$/.test(args[2]) ? Number(args[2]) : null
    });
  }
  if (command === 'plist') {
    // An installer can provide its staged config while retaining the final argv path.
    var installedProfile = configuration(args[3] || args[2]).profile;
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '<key>Label</key><string>com.macflare.agent</string>\n' +
      '<key>ProgramArguments</key><array><string>/bin/bash</string><string>' + xml(args[1]) +
      '</string><string>' + (installedProfile === 'buffered' ? '--watch' : '--once') + '</string><string>--config</string><string>' + xml(args[2]) + '</string></array>\n' +
      (installedProfile === 'buffered' ? '<key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>\n' :
        '<key>StartInterval</key><integer>' + PROFILES[installedProfile].interval_seconds + '</integer>\n') +
      '<key>RunAtLoad</key><true/>\n' +
      '<key>LimitLoadToSessionType</key><string>Aqua</string>\n' +
      '<key>ProcessType</key><string>Background</string>\n' +
      '<key>StandardOutPath</key><string>/dev/null</string>\n' +
      '<key>StandardErrorPath</key><string>/dev/null</string>\n' +
      '</dict></plist>\n';
  }
  throw new Error('Unknown runtime command.');
}
