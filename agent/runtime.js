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
    if (['endpoint', 'privacy', 'blocked_apps'].indexOf(key) < 0) {
      throw new Error('Unrecognized configuration key.');
    }
  });
  var result = { endpoint: '', privacy: {}, blocked_apps: [] };
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
    var track = player.currentTrack();
    return {
      state: state,
      track: cleanString(track.name(), 500),
      artist: cleanString(track.artist(), 500)
    };
  } catch (_) {
    return unavailableMusic();
  }
}

function xml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function run(args) {
  var command = args[0];
  if (command === 'collect') return JSON.stringify(collect(configuration(args[1])));
  if (command === 'music') return JSON.stringify(music(configuration(args[1])));
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
    return JSON.stringify(config, null, 2);
  }
  if (command === 'validate') {
    endpoint(configuration(args[1]).endpoint);
    token(args[2]);
    return 'Configuration is valid.';
  }
  if (command === 'curl-config') {
    var origin = endpoint(configuration(args[1]).endpoint);
    return [
      'url = ' + JSON.stringify(origin + '/update'),
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
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '<key>Label</key><string>com.macflare.agent</string>\n' +
      '<key>ProgramArguments</key><array><string>/bin/bash</string><string>' + xml(args[1]) +
      '</string><string>--once</string><string>--config</string><string>' + xml(args[2]) + '</string></array>\n' +
      '<key>StartInterval</key><integer>30</integer>\n' +
      '<key>RunAtLoad</key><true/>\n' +
      '<key>LimitLoadToSessionType</key><string>Aqua</string>\n' +
      '<key>ProcessType</key><string>Background</string>\n' +
      '<key>StandardOutPath</key><string>/dev/null</string>\n' +
      '<key>StandardErrorPath</key><string>/dev/null</string>\n' +
      '</dict></plist>\n';
  }
  throw new Error('Unknown runtime command.');
}
