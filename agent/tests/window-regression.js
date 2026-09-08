/* Deterministic JXA window fixtures: no application events, network, or user data. */
ObjC.import('Foundation');
function run(args) {
  var source = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(args[0], $.NSUTF8StringEncoding, null));
  var W = new Function(source + '\nreturn WindowBuffer;')();
  var P = new Function(source + '\nreturn WindowPolicy;')();
  var start = 1800000000000, id = '11111111-2222-4333-8444-555555555555', passed = 0, batches = [];
  var snapshot = { schema_version: 1, collected_at: new Date(start).toISOString(), active_app: 'Finder', running_apps: ['Finder'],
    battery: { percent: 90, charging: false, power_source: 'battery' },
    system: { load_1m: 1, load_5m: 1, load_15m: 1 }, music: { state: 'stopped', track: null, artist: null } };
  function check(condition, label) { if (!condition) throw new Error(label); passed += 1; }
  function make() { return W.create(snapshot, start, id, 'fixture'); }
  function capture(state) { var body = W.batch(state, state.coverage_at); batches.push(body); return body; }
  var state = make();
  check(state.next_upload_at === start + 300000, 'first batch warms up for five minutes');
  for (var index = 1; index <= 100; index += 1) W.observe(state, { active_app: 'Finder' }, start + index * 2);
  check(state.events.length === 0 && state.coverage_at === start + 200, 'unchanged observed coverage creates no duplicate events');
  ['Editor', 'Terminal', 'Browser'].forEach(function (name, index) { W.observe(state, { active_app: name }, start + 300 + index); });
  ['First Song', 'Second Song', 'Third Song'].forEach(function (name, index) {
    W.observe(state, { music: { state: 'playing', track: name, artist: 'Artist' } }, start + 400 + index);
  });
  check(state.events.length === 6 && state.events[3].changes.music.track === 'First Song', 'sub-second app and song changes are retained');
  W.observe(state, { music: { state: 'paused', track: 'Third Song', artist: 'Artist' } }, start + 402);
  check(state.events[6].seq > state.events[5].seq && state.events[6].at === state.events[5].at, 'same timestamp keeps unique monotonic seq');
  var before = W.copy(state.events), first = capture(state), second = capture(state);
  check(first.batch_seq === 1 && second.batch_seq === 2 && JSON.stringify(before) === JSON.stringify(state.events), 'new batch has unique sequence without mutating captured transitions');
  check(W.bytes(first) < 512 * 1024 && first.window_start === first.baseline.collected_at, 'self-contained baseline and payload budget');
  var priorSeq = state.seq;
  W.observe(state, {}, start + 901000);
  check(state.baseline.active_app === 'Browser' && state.baseline.music.state === 'paused' && state.events.length === 0,
    'window expiration folds changes into baseline');
  check(state.dropped_events === 0 && state.seq === priorSeq, 'normal expiration is not overflow and seq never resets');
  check(Date.parse(state.baseline.collected_at) === state.coverage_at - 900000, 'retention is at most fifteen minutes');
  capture(state);
  state = make();
  for (index = 1; index <= 2050; index += 1) W.observe(state, { active_app: 'App ' + index }, start + index);
  check(state.events.length <= 2048 && state.dropped_events > 0 && state.seq === 2050, 'event overflow is counted and bounded');
  check(state.baseline.active_app !== 'Finder' && state.gaps.every(function (gap) { return gap.start_at < gap.end_at; }), 'overflow advances self-contained baseline without zero-duration gap');
  capture(state);
  state = make();
  var longNames = [];
  for (index = 0; index < 64; index += 1) longNames.push(Array(190).join('中') + index);
  for (index = 1; index <= 30; index += 1) W.observe(state, { running_apps: longNames.slice(0, 30 + index) }, start + index);
  check(W.bytes(capture(state)) <= 512 * 1024 && state.dropped_events > 0, 'UTF-8 byte overflow advances baseline');
  state = make(); W.observe(state, {}, start + 9000);
  W.gap(state, start + 1000, start + 4000, 'sleep');
  W.gap(state, start + 3000, start + 5000, 'restart');
  W.gap(state, start + 7000, start + 7000, 'collection');
  check(state.gaps.length === 1 && state.gaps[0].reason === 'collection' && Date.parse(state.gaps[0].end_at) === start + 5000,
    'overlapping reasons merge; zero-duration gaps are excluded');
  W.gap(state, start + 6000, start + 8000, 'sleep');
  check(state.gaps.length === 2, 'separate gaps stay sorted'); capture(state);
  W.observe(state, {}, start + 908000);
  check(state.gaps.length === 0, 'gaps ending at window boundary expire'); capture(state);
  state = make(); W.observe(state, { active_app: 'Editor' }, start + 2000);
  var recovered = W.restored(W.copy(state), 'fixture', start + 10000);
  check(recovered && recovered.session_id === id && recovered.seq === 1, 'restart restores session and sequence');
  check(recovered.coverage_at === state.coverage_at, 'recovery cannot claim new observation before a fresh sample');
  W.resume(recovered, snapshot, start + 10000);
  check(recovered.gaps[0].reason === 'restart' && recovered.gaps[0].start_at === new Date(start + 2000).toISOString(), 'restart exposes unobserved interval');
  check(recovered.next_upload_at === start + 300000, 'restart retains the existing upload deadline'); capture(recovered);
  var nearDeadline = W.restored(W.copy(state), 'fixture', start + 299000);
  check(nearDeadline.next_upload_at === start + 300000, 'late restart cannot postpone a pending upload another five minutes');
  check(W.restored(W.copy(state), 'fixture', start + 301000).next_upload_at === start + 301000, 'overdue restart schedules upload after fresh observation');
  check(W.restored(state, 'changed privacy', start + 10000) === null, 'privacy/configuration changes reject persisted history');
  check(W.restored(state, 'fixture', start + 1000) === null, 'backwards clock cannot reuse future cache');
  check(W.restored(state, 'fixture', start + 1000000) === null, 'old checkpoints expire');
  var invalid = W.copy(state); invalid.events[0].seq = 0;
  check(W.restored(invalid, 'fixture', start + 10000) === null, 'corrupt event sequence is rejected');
  invalid = W.copy(state); invalid.events[0].changes.document_title = 'never permitted';
  check(W.restored(invalid, 'fixture', start + 10000) === null, 'unknown persisted data is rejected');
  var corruptions = [
    function (value) { value.baseline.extra = 'unexpected'; },
    function (value) { value.baseline.battery.percent = 'bad'; },
    function (value) { value.current.system = []; },
    function (value) { value.current.active_app = 'inconsistent reconstruction'; },
    function (value) { value.events[0].changes.active_app = []; },
    function (value) { value.events[0].at = value.events[0].at.replace('.000Z', 'Z'); },
    function (value) { value.baseline.collected_at = value.baseline.collected_at.replace('.000Z', 'Z'); },
    function (value) { value.baseline.music = { state: 'playing', track: 'Song', artist: 'Artist', artwork_url: 'https://evil.test/a', track_url: 'https://music.apple.com/a' }; },
    function (value) { value.gaps = [{ start_at: new Date(start + 1000).toISOString(), end_at: new Date(start + 2000).toISOString(), reason: 'sleep' },
      { start_at: new Date(start + 1500).toISOString(), end_at: new Date(start + 2000).toISOString(), reason: 'restart' }]; },
    function (value) { value.seq = Number.MAX_SAFE_INTEGER; },
    function (value) { value.batch_seq = Number.MAX_SAFE_INTEGER; }
  ];
  corruptions.forEach(function (corrupt, index) {
    var value = W.copy(state); corrupt(value);
    check(W.restored(value, 'fixture', start + 10000) === null, 'corrupt checkpoint rejected case ' + index);
  });
  var threw = false; try { W.observe(state, {}, start); } catch (_) { threw = true; }
  check(threw, 'clock reversal requires a new session');
  threw = false; try { W.batch(state, start + 33000); } catch (_) { threw = true; }
  check(threw, 'unobserved time cannot be transmitted as coverage');
  state = make();
  var delays = [];
  for (index = 0; index < 8; index += 1) { W.result(state, start, false, 1); delays.push(state.next_upload_at - start); }
  check(JSON.stringify(delays) === JSON.stringify([15000, 30000, 60000, 120000, 240000, 300000, 300000, 300000]), 'exponential retry is bounded at five minutes');
  W.result(state, start, true, 0);
  check(state.failures === 0 && state.next_upload_at === start + 300000, 'success resets retries to nominal cadence');
  W.result(state, start, false, 0);
  check(state.next_upload_at === start + 12000, 'retry jitter has a finite lower bound');
  check(!P.checkpointDue(start, true, start + 9999) && P.checkpointDue(start, true, start + 10000), 'dirty changes wait at least ten seconds between ordinary checkpoints');
  check(!P.checkpointDue(start, false, start + 29999) && P.checkpointDue(start, false, start + 30000), 'unchanged coverage persists once per thirty seconds');
  var lastSaved = start, dirty = false, writes = 0;
  state = make();
  for (index = 1; index <= 250; index += 1) {
    var at = start + index * 100;
    dirty = W.observe(state, { active_app: 'Burst ' + index }, at) || dirty;
    if (P.checkpointDue(lastSaved, dirty, at)) { writes += 1; lastSaved = at; dirty = false; }
  }
  check(state.events.length === 250 && state.events[249].seq === 250 && writes === 2,
    'burst keeps every exact event while coalescing ordinary disk writes');
  check(state.events[0].at === new Date(start + 100).toISOString() && state.events[249].at === new Date(start + 25000).toISOString(),
    'checkpoint scheduling never changes event timestamps');
  var loads = { load_1m: 1, load_5m: 1, load_15m: 1 };
  function sample(value) { return { load_1m: value, load_5m: 1, load_15m: 1 }; }
  check(!P.systemDue(loads, sample(1.1), start, start + 30000), 'small load movement is coalesced');
  check(!P.systemDue(loads, sample(1.19), start, start + 60000), 'threshold remains against last recorded value');
  check(P.systemDue(loads, sample(1.21), start, start + 90000), 'accumulated movement reaches recorded-value threshold');
  check(P.systemDue(loads, sample(1.2), start, start + 30000), 'exact absolute threshold handles floating-point roundoff');
  check(P.systemDue({ load_1m: 3.9, load_5m: 1, load_15m: 1 }, sample(4.1), start, start + 30000), '4.1 minus 3.9 counts as the exact 0.20 threshold');
  check(!P.systemDue(loads, sample(1.01), start, start + 119999) && P.systemDue(loads, sample(1.01), start, start + 120000),
    'small real changes are retained at the 120-second deadline');
  check(!P.systemDue(loads, sample(1), start, start + 120000), 'deadline creates no event when values are unchanged');
  var high = { load_1m: 10, load_5m: 10, load_15m: 10 };
  check(!P.systemDue(high, { load_1m: 10.49, load_5m: 10, load_15m: 10 }, start, start + 30000) &&
    P.systemDue(high, { load_1m: 10, load_5m: 10.5, load_15m: 10 }, start, start + 30000), 'relative five-percent threshold applies to every component');
  check(P.systemDue(loads, { load_1m: 1, load_5m: null, load_15m: 1 }, start, start + 1) &&
    P.systemDue({ load_1m: null, load_5m: 1, load_15m: 1 }, loads, start, start + 1), 'known/unknown transitions are immediate');
  var sampled = W.copy(snapshot); sampled.battery.percent = 89; sampled.system = sample(1.01);
  var delta = P.hardwareDelta(snapshot, sampled, { battery: true, system: true }, start, start + 30000);
  check(delta.battery.percent === 89 && !delta.system, 'integer battery changes are independent of system coalescing');
  sampled.battery = W.copy(snapshot.battery); sampled.battery.charging = true;
  check(P.hardwareDelta(snapshot, sampled, { battery: true, system: true }, start, start + 30000).battery.charging === true, 'charging transitions remain exact');
  sampled.battery.charging = false; sampled.battery.power_source = 'ac';
  check(P.hardwareDelta(snapshot, sampled, { battery: true, system: true }, start, start + 30000).battery.power_source === 'ac', 'power-source transitions remain exact');
  check(!Object.keys(P.hardwareDelta(snapshot, sampled, { battery: false, system: false }, start, start + 120000)).length,
    'disabled device fields do not produce hardware events');
  state = make(); W.observe(state, { system: sample(1.5) }, start + 30000); W.observe(state, { active_app: 'Later App' }, start + 60000);
  check(P.lastSystemRecordedAt(state) === start + 30000, 'last system time derives from its latest event rather than app or coverage time');
  var saved = W.restored(W.copy(state), 'fixture', start + 70000);
  check(P.lastSystemRecordedAt(saved) === start + 30000, 'unchanged checkpoint version preserves derived system timing across recovery');
  var unknown = W.copy(snapshot); unknown.system = { load_1m: null, load_5m: null, load_15m: null };
  W.resume(saved, unknown, start + 70000);
  check(P.lastSystemRecordedAt(saved) === start + 70000 && P.systemDue(saved.current.system, sample(1.01), start + 70000, start + 70001),
    'resume resets the timing through an unknown event and accepts the next fresh metrics immediately');
  capture(state); capture(saved);
  return JSON.stringify({ passed: passed, batches: batches });
}
