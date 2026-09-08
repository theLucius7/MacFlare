/* Native JXA event collector. Pure window operations also run in fixture tests. */
var WindowBuffer = (function () {
  var WINDOW_MS = 900000, MAX_EVENTS = 2048, MAX_BYTES = 512 * 1024;
  var FIELDS = ['active_app', 'running_apps', 'battery', 'system', 'music'];
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function iso(value) { return new Date(value).toISOString(); }
  function bytes(value) { return unescape(encodeURIComponent(JSON.stringify(value))).length; }
  function keys(value, required, optional) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      required.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); }) &&
      Object.keys(value).every(function (key) { return required.concat(optional || []).indexOf(key) >= 0; });
  }
  function time(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
    var parsed = Date.parse(value);
    return Number.isFinite(parsed) && iso(parsed) === value ? parsed : NaN;
  }
  function text(value, maximum) {
    return value === null || (typeof value === 'string' && value.length > 0 &&
      Array.from(value).length <= maximum && !/[\u0000-\u001f\u007f]/.test(value));
  }
  function number(value, maximum) { return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum); }
  function url(value, image) {
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    var matched = /^https:\/\/([a-zA-Z0-9.-]+)(?:[/?#]|$)/.exec(value);
    if (!matched || !/^[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*$/.test(matched[1])) return false;
    var host = matched[1].toLowerCase();
    return image ? host.length > 13 && host.slice(-13) === '.mzstatic.com' : host === 'itunes.apple.com' || host === 'music.apple.com';
  }
  function field(name, value) {
    if (name === 'active_app') return text(value, 200);
    if (name === 'running_apps') return Array.isArray(value) && value.length <= 64 && value.every(function (entry, index) {
      return entry !== null && text(entry, 200) && value.indexOf(entry) === index;
    });
    if (name === 'battery') return keys(value, ['percent', 'charging', 'power_source']) && number(value.percent, 100) &&
      (value.charging === null || typeof value.charging === 'boolean') && ['ac', 'battery', 'unknown'].indexOf(value.power_source) >= 0;
    if (name === 'system') return keys(value, ['load_1m', 'load_5m', 'load_15m']) &&
      Object.keys(value).every(function (key) { return number(value[key], 100000); });
    if (name !== 'music' || !keys(value, ['state', 'track', 'artist'], ['artwork_url', 'track_url']) ||
      ['playing', 'paused', 'stopped', 'unavailable'].indexOf(value.state) < 0 || !text(value.track, 500) || !text(value.artist, 500)) return false;
    var art = Object.prototype.hasOwnProperty.call(value, 'artwork_url'), link = Object.prototype.hasOwnProperty.call(value, 'track_url');
    return art === link && (!art || (value.artwork_url === null && value.track_url === null) ||
      (url(value.artwork_url, true) && url(value.track_url, false) && ['playing', 'paused'].indexOf(value.state) >= 0 &&
        value.track && value.track.trim() && value.artist && value.artist.trim()));
  }
  function snapshotValid(value) {
    return keys(value, ['schema_version', 'collected_at', 'active_app', 'battery', 'system', 'music'], ['running_apps']) &&
      value.schema_version === 1 && Number.isFinite(time(value.collected_at)) &&
      FIELDS.every(function (key) { return !Object.prototype.hasOwnProperty.call(value, key) || field(key, value[key]); });
  }
  function apply(snapshot, changes) {
    FIELDS.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(changes, key)) snapshot[key] = copy(changes[key]); });
  }
  function create(snapshot, now, id, fingerprint) {
    var baseline = copy(snapshot); baseline.collected_at = iso(now);
    return { version: 1, fingerprint: fingerprint, session_id: id, seq: 0, batch_seq: 0,
      baseline: baseline, current: copy(baseline), events: [], gaps: [], dropped_events: 0,
      coverage_at: now, next_upload_at: now + 300000, failures: 0 };
  }
  function gap(state, start, end, reason) {
    start = Math.max(start, Date.parse(state.baseline.collected_at));
    end = Math.min(end, state.coverage_at);
    if (start >= end) return;
    state.gaps.push({ start_at: iso(start), end_at: iso(end), reason: reason });
    state.gaps.sort(function (left, right) { return Date.parse(left.start_at) - Date.parse(right.start_at); });
    var merged = [];
    state.gaps.forEach(function (item) {
      var previous = merged[merged.length - 1];
      if (previous && Date.parse(previous.end_at) >= Date.parse(item.start_at)) {
        previous.end_at = iso(Math.max(Date.parse(previous.end_at), Date.parse(item.end_at)));
        if (previous.reason !== item.reason) previous.reason = 'collection';
      } else merged.push(item);
    });
    state.gaps = merged;
    // Dense faults remain explicit without permitting an unbounded checkpoint.
    if (state.gaps.length > 128) {
      state.gaps.splice(0, 2, { start_at: state.gaps[0].start_at, end_at: state.gaps[1].end_at, reason: 'collection' });
    }
  }
  function advance(state, boundary) {
    boundary = Math.min(boundary, state.coverage_at);
    while (state.events.length && Date.parse(state.events[0].at) <= boundary) apply(state.baseline, state.events.shift().changes);
    state.baseline.collected_at = iso(boundary);
    state.gaps = state.gaps.filter(function (item) { return Date.parse(item.end_at) > boundary; }).map(function (item) {
      return { start_at: iso(Math.max(boundary, Date.parse(item.start_at))), end_at: item.end_at, reason: item.reason };
    });
  }
  function body(state, generated) {
    return { schema_version: 2, session_id: state.session_id, batch_seq: state.batch_seq,
      generated_at: iso(generated), window_start: state.baseline.collected_at, window_end: iso(state.coverage_at),
      baseline: copy(state.baseline), events: copy(state.events), gaps: copy(state.gaps), dropped_events: state.dropped_events };
  }
  function prune(state) {
    var boundary = state.coverage_at - WINDOW_MS;
    if (boundary > Date.parse(state.baseline.collected_at)) advance(state, boundary);
    var packet = body(state, state.coverage_at), limit = MAX_BYTES - 4096;
    if (state.events.length && (state.events.length > MAX_EVENTS || bytes(packet) > limit)) {
      // Compute a cut in one pass. Re-serializing the whole window for every
      // removed event makes a large artwork backfill quadratic on the run loop.
      var sizes = state.events.map(function (event) { return bytes(event) + 1; });
      var remaining = sizes.reduce(function (sum, size) { return sum + size; }, 0);
      packet.events = [];
      var candidate = copy(state.baseline), fixed = bytes(packet) - bytes(candidate), count = 0;
      while (count < state.events.length &&
        (state.events.length - count > MAX_EVENTS || fixed + bytes(candidate) + Math.max(0, remaining - 1) > limit)) {
        apply(candidate, state.events[count].changes);
        remaining -= sizes[count]; count += 1;
      }
      if (count) {
        var before = state.events.length;
        // Incorporate all events at the cut timestamp into the baseline.
        advance(state, Date.parse(state.events[count - 1].at));
        state.dropped_events += before - state.events.length;
      }
    }
    // Moving window_start and dropped_events explicitly describe discarded history.
    // A zero-duration gap would falsely claim missing coverage inside the retained window.
  }
  function observe(state, changes, now) {
    if (now < state.coverage_at) throw new Error('Clock moved backwards.');
    state.coverage_at = now;
    var delta = {};
    FIELDS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(changes, key) && JSON.stringify(changes[key]) !== JSON.stringify(state.current[key])) {
        delta[key] = copy(changes[key]);
      }
    });
    if (Object.keys(delta).length) {
      state.seq += 1;
      state.events.push({ seq: state.seq, at: iso(now), changes: delta });
      apply(state.current, delta);
    }
    state.current.collected_at = iso(now);
    prune(state);
    return Object.keys(delta).length > 0;
  }
  function batch(state, now) {
    if (now < state.coverage_at || now - state.coverage_at > 30000) throw new Error('No recent observation.');
    prune(state); state.batch_seq += 1;
    var result = body(state, now);
    if (bytes(result) > MAX_BYTES) throw new Error('Window exceeds payload limit.');
    return result;
  }
  function result(state, now, success, random) {
    state.failures = success ? 0 : Math.min(state.failures + 1, 8);
    var seconds = success ? 300 : Math.min(300, 15 * Math.pow(2, state.failures - 1));
    // Jitter never exceeds the requested five-minute retry ceiling.
    state.next_upload_at = now + Math.round(seconds * (success ? 1 : 0.8 + 0.2 * random) * 1000);
  }
  function restored(raw, fingerprint, now) {
    if (!keys(raw, ['version', 'fingerprint', 'session_id', 'seq', 'batch_seq', 'baseline', 'current', 'events', 'gaps',
      'dropped_events', 'coverage_at', 'next_upload_at', 'failures']) || raw.version !== 1 || raw.fingerprint !== fingerprint ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw.session_id) ||
      !Number.isSafeInteger(raw.seq) || raw.seq < 0 || raw.seq >= Number.MAX_SAFE_INTEGER - MAX_EVENTS ||
      !Number.isSafeInteger(raw.batch_seq) || raw.batch_seq < 0 || raw.batch_seq >= Number.MAX_SAFE_INTEGER - 1 ||
      !Number.isSafeInteger(raw.dropped_events) || raw.dropped_events < 0 ||
      !Number.isSafeInteger(raw.next_upload_at) || !Number.isSafeInteger(raw.failures) || raw.failures < 0 || raw.failures > 8 ||
      !Number.isSafeInteger(raw.coverage_at) || raw.coverage_at > now || now - raw.coverage_at > WINDOW_MS ||
      !snapshotValid(raw.baseline) || !snapshotValid(raw.current) || !Array.isArray(raw.events) ||
      raw.events.length > MAX_EVENTS || !Array.isArray(raw.gaps) || raw.gaps.length > 128 || bytes(raw) > MAX_BYTES * 2) return null;
    var start = time(raw.baseline.collected_at), previous = start, seq = 0, reconstructed = copy(raw.baseline);
    if (!Number.isFinite(start) || start > raw.coverage_at || raw.coverage_at - start > WINDOW_MS) return null;
    for (var index = 0; index < raw.events.length; index += 1) {
      var event = raw.events[index], at = time(event.at);
      if (!keys(event, ['seq', 'at', 'changes']) || !Number.isSafeInteger(event.seq) || event.seq <= seq || event.seq > raw.seq ||
        !Number.isFinite(at) || at < previous || at > raw.coverage_at || !keys(event.changes, [], FIELDS) ||
        !Object.keys(event.changes).length || Object.keys(event.changes).some(function (key) { return !field(key, event.changes[key]); })) return null;
      seq = event.seq; previous = at;
      apply(reconstructed, event.changes);
    }
    if (FIELDS.some(function (key) { return JSON.stringify(reconstructed[key]) !== JSON.stringify(raw.current[key]); }) ||
      time(raw.current.collected_at) > raw.coverage_at || time(raw.current.collected_at) < start) return null;
    var previousGap = start;
    if (raw.gaps.some(function (item) {
      var startAt = time(item.start_at), endAt = time(item.end_at);
      var invalid = !keys(item, ['start_at', 'end_at', 'reason']) || ['sleep', 'restart', 'collection', 'overflow', 'clock'].indexOf(item.reason) < 0 ||
        !Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt < previousGap || endAt > raw.coverage_at || startAt >= endAt;
      previousGap = endAt; return invalid;
    })) return null;
    var state = copy(raw);
    // Recovery preserves the upload deadline; repeated crashes cannot postpone it forever.
    // Coverage remains the last actual observation until resume() receives a fresh sample.
    state.next_upload_at = Math.max(now, Math.min(now + 300000, state.next_upload_at));
    return state;
  }
  function resume(state, snapshot, now) {
    var previous = state.coverage_at, fresh = {};
    FIELDS.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(snapshot, key)) fresh[key] = snapshot[key]; });
    observe(state, fresh, now); gap(state, previous, now, 'restart');
    return state;
  }
  return { create: create, observe: observe, gap: gap, batch: batch, result: result, restored: restored,
    resume: resume, copy: copy, bytes: bytes, prune: prune, WINDOW_MS: WINDOW_MS, MAX_EVENTS: MAX_EVENTS };
}());

function run(args) {
  ObjC.import('Foundation'); ObjC.import('AppKit');
  ObjC.bindFunction('kill', ['int', ['int', 'int']]);
  ObjC.bindFunction('getuid', ['unsigned int', []]);
  ObjC.bindFunction('open', ['int', ['char *', 'int', 'int']]);
  ObjC.bindFunction('flock', ['int', ['int', 'int']]);
  ObjC.bindFunction('fchmod', ['int', ['int', 'unsigned short']]);
  ObjC.bindFunction('close', ['int', ['int']]);
  var source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null));
  var native = new Function(source + '\nreturn {configuration:configuration,collect:collect,blocked:blocked,clean:cleanString,read:readText,write:writePrivateText,run:run,unavailable:unavailableMusic,normalize:artworkNormalized,safe:artworkSafeUrl};')();
  var configPath = args[1], tokenPath = args[2], temporary = args[3], noUpload = args[4] === 'observe';
  var duration = noUpload ? Number(args[5]) : 0, began = Date.now();
  var config = native.configuration(configPath), fingerprint = JSON.stringify(config);
  var capturedConfig = temporary + '/captured-config.json';
  native.write(capturedConfig, fingerprint);
  var directory = noUpload ? temporary : ObjC.unwrap($(configPath).stringByDeletingLastPathComponent);
  var checkpoint = directory + '/window-cache.json';
  var state, musicRevision = 0, lastLoop = began, lastUptime = Number($.NSProcessInfo.processInfo.systemUptime), lastFlush = 0, lastConfig = began, lastHardware = 0, lastMusic = 0;
  var workspace = $.NSWorkspace.sharedWorkspace, tasks = {}, observations = 0, notifications = 0, uploads = 0;
  var artworkQueue = [], artworkCache = {}, recentMusicKeys = [], asleep = false, terminated = false;
  var lockDescriptor = -1;
  function uuid() { return ObjC.unwrap($.NSUUID.UUID.UUIDString).toLowerCase(); }
  function privatePath(path) {
    var attributes = $.NSFileManager.defaultManager.attributesOfItemAtPathError(path, null);
    if (!attributes || attributes.isNil()) return true;
    return ObjC.unwrap(attributes.objectForKey($.NSFileType)) === 'NSFileTypeRegular' &&
      Number(ObjC.unwrap(attributes.objectForKey($.NSFilePosixPermissions))) === 384 &&
      Number(ObjC.unwrap(attributes.objectForKey($.NSFileOwnerAccountID))) === Number($.getuid());
  }
  function flush() {
    if (!privatePath(checkpoint)) throw new Error('Window cache must be a private regular file.');
    native.write(checkpoint, JSON.stringify(state)); lastFlush = Date.now();
  }
  function apps() {
    var changes = {};
    if (config.privacy.active_app) {
      changes.active_app = null;
      try {
        var app = workspace.frontmostApplication;
        if (app && !app.isNil()) {
          var name = ObjC.unwrap(app.localizedName), bundle = ObjC.unwrap(app.bundleIdentifier);
          changes.active_app = native.blocked(name, bundle, config) ? 'System' : native.clean(name, 200);
        }
      } catch (_) {}
    }
    if (config.privacy.running_apps) {
      var names = [];
      try {
        (ObjC.unwrap(workspace.runningApplications) || []).forEach(function (app) {
          if (Number(app.activationPolicy) !== 0) return;
          var name = ObjC.unwrap(app.localizedName);
          if (native.blocked(name, ObjC.unwrap(app.bundleIdentifier), config)) return;
          name = native.clean(name, 200);
          if (name && names.indexOf(name) < 0) names.push(name);
        });
      } catch (_) {}
      changes.running_apps = names.sort().slice(0, 64);
    }
    return changes;
  }
  function initial(now) {
    var base = { schema_version: 1, collected_at: new Date(now).toISOString(), active_app: null,
      battery: { percent: null, charging: null, power_source: 'unknown' },
      system: { load_1m: null, load_5m: null, load_15m: null }, music: native.unavailable() };
    var currentApps = apps(); Object.keys(currentApps).forEach(function (key) { base[key] = currentApps[key]; });
    return WindowBuffer.create(base, now, uuid(), fingerprint);
  }
  if (!noUpload) {
    var lockPath = directory + '/window-lock';
    if (!privatePath(lockPath)) throw new Error('Window lock must be a private regular file.');
    // Darwin O_RDWR | O_CREAT | O_NOFOLLOW. flock is released by the kernel on exit.
    lockDescriptor = $.open(lockPath, 2 | 512 | 256, 384);
    if (lockDescriptor < 0 || $.fchmod(lockDescriptor, 384) !== 0) throw new Error('Could not protect the native window lock.');
    if ($.flock(lockDescriptor, 2 | 4) !== 0) throw new Error('A buffered collector is already running.');
  }
  try {
    var cacheAttributes = $.NSFileManager.defaultManager.attributesOfItemAtPathError(checkpoint, null);
    if (privatePath(checkpoint) && cacheAttributes && !cacheAttributes.isNil() &&
      Number(ObjC.unwrap(cacheAttributes.objectForKey($.NSFileSize))) <= 1048576) {
      state = WindowBuffer.restored(JSON.parse(native.read(checkpoint, true)), fingerprint, began);
    }
  } catch (_) {}
  if (!state) state = initial(began);
  else WindowBuffer.resume(state, initial(began).current, began);
  // Private history never survives a configuration change, including endpoint and blocklist.
  function reset(now, reason) {
    state = initial(now); musicRevision += 1;
    artworkQueue = []; artworkCache = {}; recentMusicKeys = [];
    Object.keys(tasks).forEach(function (key) { stop(tasks[key]); }); tasks = {};
    native.write(capturedConfig, fingerprint);
    lastHardware = 0; lastMusic = 0;
    if (!reason) state.next_upload_at = now;
    flush();
  }
  function observed(changes, now) {
    now = now || Date.now();
    if (now < state.coverage_at) reset(now, 'clock');
    var changed = WindowBuffer.observe(state, changes, now); observations += 1;
    if (changed || now - lastFlush >= 2000) flush();
  }
  function stop(job) {
    if (job.task.running) {
      job.task.terminate;
      if (job.task.running) $.kill(Number(job.task.processIdentifier), 9);
    }
  }
  function launch(key, executable, argumentsList, timeout, done) {
    if (tasks[key]) return false;
    var task = $.NSTask.alloc.init, pipe = $.NSPipe.pipe;
    task.launchPath = executable; task.arguments = $(argumentsList);
    task.standardOutput = pipe; task.standardError = $.NSFileHandle.fileHandleForWritingAtPath('/dev/null');
    task.launch;
    tasks[key] = { task: task, pipe: pipe, deadline: Date.now() + timeout, done: done };
    return true;
  }
  function finishTasks(now) {
    Object.keys(tasks).forEach(function (key) {
      var job = tasks[key], timedOut = job.task.running && now >= job.deadline;
      if (timedOut) stop(job);
      if (job.task.running) return;
      delete tasks[key];
      var output = '';
      try {
        var data = job.pipe.fileHandleForReading.readDataToEndOfFile;
        if (Number(data.length) <= 65536) output = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
      } catch (_) {}
      try { job.done(!timedOut && Number(job.task.terminationStatus) === 0, output.trim(), now); } catch (_) {
        WindowBuffer.gap(state, now, now, 'collection');
      }
    });
  }
  function songKey(music) { return JSON.stringify([native.normalize(music.track), native.normalize(music.artist)]); }
  function validSong(music) { return ['playing', 'paused'].indexOf(music.state) >= 0 && native.normalize(music.track) && native.normalize(music.artist); }
  function musicChanged(value, at) {
    var item = { state: value.state, track: value.track, artist: value.artist };
    if (validSong(item)) {
      var key = songKey(item), cached = artworkCache[key];
      if (cached && cached.expires > at && cached.value) Object.assign(item, cached.value);
      if (!cached || cached.expires <= at) {
        if (!artworkQueue.some(function (entry) { return entry.key === key; })) artworkQueue.push({ key: key, music: item });
        artworkQueue = artworkQueue.slice(-32);
      }
    }
    musicRevision += 1; observed({ music: item }, at);
  }
  function requestMusic(now) {
    if (!config.privacy.music || tasks.music) return;
    var revision = musicRevision;
    lastMusic = now;
    launch('music', '/usr/bin/osascript', ['-l', 'JavaScript', args[0], 'music', capturedConfig], 5000, function (success, output, finished) {
      if (revision !== musicRevision) return;
      if (success) {
        try { musicChanged(JSON.parse(output), finished); return; } catch (_) {}
      }
      musicChanged(native.unavailable(), finished);
      WindowBuffer.gap(state, lastMusic, finished, 'collection'); flush();
    });
  }
  function hardware(now) {
    if (tasks.hardware || (!config.privacy.battery && !config.privacy.system)) return;
    lastHardware = now;
    launch('hardware', '/usr/bin/osascript', ['-l', 'JavaScript', args[0], 'collect', capturedConfig], 6000, function (success, output, finished) {
      if (!success) {
        var missing = {};
        if (config.privacy.battery) missing.battery = { percent: null, charging: null, power_source: 'unknown' };
        if (config.privacy.system) missing.system = { load_1m: null, load_5m: null, load_15m: null };
        observed(missing, finished); WindowBuffer.gap(state, lastHardware, finished, 'collection'); flush(); return;
      }
      var data = JSON.parse(output), delta = {};
      if (config.privacy.battery) delta.battery = data.battery;
      if (config.privacy.system) delta.system = data.system;
      observed(delta, finished);
    });
  }
  function artwork(now) {
    if (tasks.artwork || !artworkQueue.length || !config.privacy.music) return;
    var entry = artworkQueue.shift();
    native.write(temporary + '/artwork-input.json', JSON.stringify(entry.music));
    launch('artwork', '/usr/bin/osascript', ['-l', 'JavaScript', args[0], 'artwork', temporary + '/artwork-input.json',
      temporary + '/artwork-cache.json', temporary, capturedConfig], 8000, function (success, output, finished) {
      var value = null;
      try {
        var enriched = JSON.parse(output);
        if (success && songKey(enriched) === entry.key && native.safe(enriched.artwork_url, true) && native.safe(enriched.track_url, false)) {
          value = { artwork_url: enriched.artwork_url, track_url: enriched.track_url };
        }
      } catch (_) {}
      artworkCache[entry.key] = { value: value, expires: finished + (value ? 900000 : 300000) };
      recentMusicKeys = recentMusicKeys.filter(function (key) { return key !== entry.key; }); recentMusicKeys.push(entry.key);
      while (recentMusicKeys.length > 64) delete artworkCache[recentMusicKeys.shift()];
      if (value) {
        // Artwork is derived metadata: preserve capture timestamps and source transitions.
        [state.baseline].concat(state.events.map(function (event) { return event.changes; })).forEach(function (snapshot) {
          if (snapshot.music && validSong(snapshot.music) && songKey(snapshot.music) === entry.key) Object.assign(snapshot.music, value);
        });
        if (validSong(state.current.music) && songKey(state.current.music) === entry.key) {
          observed({ music: Object.assign({}, state.current.music, value) }, finished);
        }
        WindowBuffer.prune(state);
        flush();
      }
    });
  }
  function upload(now) {
    if (noUpload || tasks.upload || now < state.next_upload_at || asleep) return;
    var latestConfig = native.configuration(configPath), latestFingerprint = JSON.stringify(latestConfig);
    if (latestFingerprint !== fingerprint) {
      config = latestConfig; fingerprint = latestFingerprint; reset(now); return;
    }
    var payload = WindowBuffer.batch(state, now); flush();
    native.write(temporary + '/batch.json', JSON.stringify(payload));
    native.write(temporary + '/batch-curl.conf', native.run(['curl-config', capturedConfig, tokenPath, temporary + '/batch.json', 'batch']));
    uploads += 1;
    launch('upload', '/usr/bin/curl', ['-q', '--config', temporary + '/batch-curl.conf'], 15000, function (success, output, finished) {
      var accepted = success && /^2[0-9][0-9]$/.test(output);
      WindowBuffer.result(state, finished, accepted, Math.random());
      native.write(directory + '/last-result.json', JSON.stringify({ last_attempt: new Date(finished).toISOString(),
        success: accepted, http_status: /^[0-9]{3}$/.test(output) ? Number(output) : null,
        mode: 'buffered', batch_seq: payload.batch_seq, event_count: payload.events.length,
        next_attempt: new Date(state.next_upload_at).toISOString() }));
      flush();
    });
  }
  var observerName = 'MacFlareWindowObserver' + Date.now();
  ObjC.registerSubclass({ name: observerName, methods: {
    'workspaceChanged:': { types: ['void', ['id']], implementation: function (note) {
      if (asleep) return;
      try {
        notifications += 1;
        var delta = apps();
        if (config.privacy.active_app && ObjC.unwrap(note.name) === 'NSWorkspaceDidActivateApplicationNotification') {
          var activated = note.userInfo.objectForKey($.NSWorkspaceApplicationKey);
          var name = ObjC.unwrap(activated.localizedName), bundle = ObjC.unwrap(activated.bundleIdentifier);
          delta.active_app = native.blocked(name, bundle, config) ? 'System' : native.clean(name, 200);
        }
        observed(delta);
      } catch (_) {}
    } },
    'musicChanged:': { types: ['void', ['id']], implementation: function (note) {
      if (!config.privacy.music || asleep) return;
      try {
        notifications += 1;
        // Notifications contain untrusted optional metadata; take only this whitelist.
        var info = ObjC.deepUnwrap(note.userInfo) || {};
        var raw = typeof info['Player State'] === 'string' ? info['Player State'].toLowerCase() : '';
        if (['playing', 'paused', 'stopped'].indexOf(raw) < 0) { lastMusic = 0; return; }
        if (raw !== 'stopped' && (typeof info.Name !== 'string' || typeof info.Artist !== 'string')) { lastMusic = 0; return; }
        var track = raw === 'stopped' ? null : native.clean(info.Name, 500);
        var artist = raw === 'stopped' ? null : native.clean(info.Artist, 500);
        if (raw !== 'stopped' && (!track || !artist)) { lastMusic = 0; return; }
        musicChanged({ state: raw, track: track, artist: artist }, Date.now()); lastMusic = 0;
      } catch (_) { lastMusic = 0; }
    } },
    'willSleep:': { types: ['void', ['id']], implementation: function () {
      asleep = true; musicRevision += 1;
      if (tasks.upload) state.next_upload_at = Math.min(state.next_upload_at, Date.now());
      // No pre-sleep result may be labeled as a fresh post-wake observation.
      Object.keys(tasks).forEach(function (key) { stop(tasks[key]); }); tasks = {};
      flush();
    } },
    'didWake:': { types: ['void', ['id']], implementation: function () {
      var now = Date.now(), previous = state.coverage_at; asleep = false;
      if (now < previous) reset(now, 'clock');
      else {
        var awake = initial(now).current;
        observed(awake, now); WindowBuffer.gap(state, previous, now, 'sleep'); flush();
      }
      if (now - previous >= 300000) state.next_upload_at = now;
      lastLoop = now; lastUptime = Number($.NSProcessInfo.processInfo.systemUptime);
      lastMusic = 0; lastHardware = 0;
    } }
  } });
  var observer = $[observerName].alloc.init, center = workspace.notificationCenter;
  [$.NSWorkspaceDidActivateApplicationNotification, $.NSWorkspaceDidLaunchApplicationNotification,
    $.NSWorkspaceDidTerminateApplicationNotification].forEach(function (name) { center.addObserverSelectorNameObject(observer, 'workspaceChanged:', name, undefined); });
  center.addObserverSelectorNameObject(observer, 'willSleep:', $.NSWorkspaceWillSleepNotification, undefined);
  center.addObserverSelectorNameObject(observer, 'didWake:', $.NSWorkspaceDidWakeNotification, undefined);
  var distributed = $.NSDistributedNotificationCenter.defaultCenter;
  distributed.addObserverSelectorNameObject(observer, 'musicChanged:', 'com.apple.Music.playerInfo', undefined);
  distributed.addObserverSelectorNameObject(observer, 'musicChanged:', 'com.apple.iTunes.playerInfo', undefined);
  flush();
  try {
    while (!terminated && (!duration || Date.now() - began < duration * 1000)) {
      var now = Date.now();
      var uptime = Number($.NSProcessInfo.processInfo.systemUptime);
      if (now < lastLoop || (!asleep && Math.abs((now - lastLoop) - (uptime - lastUptime) * 1000) > 5000)) reset(now, 'clock');
      else if (!asleep && now - lastLoop > 5000) {
        var previous = state.coverage_at; observed(apps(), now); WindowBuffer.gap(state, previous, now, 'collection');
      }
      lastLoop = now; lastUptime = uptime; finishTasks(now);
      if (now - lastConfig >= 2000) {
        var next = native.configuration(configPath), nextFingerprint = JSON.stringify(next);
        if (nextFingerprint !== fingerprint) { config = next; fingerprint = nextFingerprint; reset(now); }
        lastConfig = now;
      }
      if (!asleep) {
        if (now - state.coverage_at >= 2000) observed(apps(), now);
        if (now - lastMusic >= 2000) requestMusic(now);
        if (now - lastHardware >= 30000) hardware(now);
        artwork(now); upload(now);
      }
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
    }
  } finally {
    center.removeObserver(observer); distributed.removeObserver(observer);
    Object.keys(tasks).forEach(function (key) { stop(tasks[key]); }); flush();
    if (lockDescriptor >= 0) $.close(lockDescriptor);
  }
  return JSON.stringify({ duration_seconds: (Date.now() - began) / 1000, observations: observations,
    notifications: notifications, events: state.events.length, uploads: uploads,
    checkpoint_bytes: WindowBuffer.bytes(state), dropped_events: state.dropped_events });
}
