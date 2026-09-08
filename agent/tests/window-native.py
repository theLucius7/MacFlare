"""Native run-loop fixtures use only local fake notifications and a loopback server.
They never change focus, send Music Apple Events, or upload to the public Worker.
"""
import http.server
import datetime
import concurrent.futures
import json
import pathlib
import secrets
import subprocess
import tempfile
import threading
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
received = []
reply = {'status': 503}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        received.append((self.path, json.loads(self.rfile.read(int(self.headers['content-length'])))))
        time.sleep(2)  # Real curl waits while the real native callback queue keeps running.
        self.send_response(reply['status'])
        self.end_headers()

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
source = (REPO/'agent/window-runtime.js').read_text()
# Only fixture timing and simulated OS input are injected. The collector, callback
# implementations, async NSTask path, checkpointing, privacy and lock are unchanged.
source = source.replace('var duration = noUpload ? Number(args[5]) : 0', 'var duration = Number(args[5])')
source = source.replace('if (now - lastMusic >= 2000) requestMusic(now);', '/* Music is simulated by a local selector below. */')
source = source.replace('artwork(now); upload(now);', 'upload(now); /* No Apple requests in fixtures. */')
setup = r'''
  var fixtureSent = false;
  var fixtureNames = ['Fixture A', 'Fixture B', 'Fixture C'];
  fixtureNames.forEach(function(name,index) {
    ObjC.registerSubclass({name:'MacFlareFixtureApp'+index,methods:{
      localizedName:{types:['id',[]],implementation:function(){return $(name);}},
      bundleIdentifier:{types:['id',[]],implementation:function(){return $('dev.macflare.fixture'+index);}}
    }});
  });
  state.next_upload_at = began;
'''
source = source.replace('  flush();\n  try {', setup+'\n  flush();\n  try {')
stimulus = r'''
      if (!fixtureSent && now - began >= 400) {
        fixtureNames.forEach(function(name,index) {
          var app = $['MacFlareFixtureApp'+index].alloc.init;
          center.postNotificationNameObjectUserInfo($.NSWorkspaceDidActivateApplicationNotification,workspace,$({NSWorkspaceApplicationKey:app}));
          // Call the actual selector locally, without broadcasting a fake Music
          // notification to other applications or touching Music.app.
          observer.musicChanged($.NSNotification.notificationWithNameObjectUserInfo('com.apple.Music.playerInfo',undefined,
            $({'Player State':'Playing',Name:'Fixture Song '+index,Artist:'Fixture Artist'})));
        });
        fixtureSent = true;
      }
'''
source = source.replace('lastLoop = now; lastUptime = uptime; finishTasks(now);', 'lastLoop = now; lastUptime = uptime; finishTasks(now);'+stimulus)

with tempfile.TemporaryDirectory(prefix='macflare-window-native-') as folder:
    root = pathlib.Path(folder)
    config = root/'config.json'
    settings = {'endpoint': f'http://127.0.0.1:{server.server_port}', 'profile': 'buffered',
                'privacy': {'active_app': True, 'running_apps': False, 'battery': False, 'system': False, 'music': True}}
    config.write_text(json.dumps(settings)); config.chmod(0o600)
    token = root/'token'; secret = secrets.token_hex(32)
    token.write_text(secret); token.chmod(0o600)
    script = root/'window-fixture.js'; script.write_text(source)
    argv = ['/usr/bin/osascript', '-l', 'JavaScript', str(script), str(REPO/'agent/runtime.js'), str(config), str(token), str(root), 'watch', '4']
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    # Verify an actual live process holds the OS lock; no stale PID assumption.
    deadline = time.monotonic() + 2
    while not (root/'window-cache.json').exists() and time.monotonic() < deadline:
        assert process.poll() is None
        time.sleep(0.05)
    duplicate = subprocess.run(argv, capture_output=True, text=True, timeout=3)
    assert duplicate.returncode != 0 and 'already running' in duplicate.stderr, (duplicate.returncode, duplicate.stdout, duplicate.stderr)
    stdout, stderr = process.communicate(timeout=8)
    assert process.returncode == 0, stderr
    assert secret not in stdout + stderr + duplicate.stdout + duplicate.stderr
    report = json.loads(stdout)
    assert report['checkpoint_writes'] == 4 and report['checkpoint_ordinary_writes'] == 0, 'startup, pre/post failed upload and final exit force saves; notifications do not'
    state = json.loads((root/'window-cache.json').read_text())
    names = [event['changes']['active_app'] for event in state['events'] if 'active_app' in event['changes']]
    songs = [event['changes']['music']['track'] for event in state['events'] if 'music' in event['changes']]
    assert names[:3] == ['Fixture A', 'Fixture B', 'Fixture C'], names
    assert songs == ['Fixture Song 0', 'Fixture Song 1', 'Fixture Song 2'], songs
    assert report['notifications'] == 6 and report['uploads'] == 1
    assert len(received) == 1 and received[0][0] == '/api/batch'
    first_batch = received[0][1]
    assert first_batch['events'] == [], 'slow request must hold its original immutable package'
    assert state['events'][0]['at'] < json.loads((root/'last-result.json').read_text())['last_attempt'], 'events were collected during the pending upload'
    assert state['failures'] == 1 and state['events'], 'failed upload must retain observed transitions'
    attempted = datetime.datetime.fromisoformat(json.loads((root/'last-result.json').read_text())['last_attempt'].replace('Z', '+00:00'))
    assert 12000 <= state['next_upload_at'] - int(attempted.timestamp()*1000) <= 15000
    assert (root/'window-cache.json').stat().st_mode & 0o777 == 0o600
    assert (root/'window-lock').stat().st_mode & 0o777 == 0o600

    # A finished process releases flock automatically. Restore the checkpoint,
    # then change privacy while it runs: old history must disappear and a fresh
    # empty-data package must be scheduled without another five-minute wait.
    previous_session = state['session_id']
    received.clear(); reply['status'] = 204
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    time.sleep(0.7)
    settings['privacy'] = {key: False for key in settings['privacy']}
    updated = root/'config-next.json'; updated.write_text(json.dumps(settings)); updated.chmod(0o600); updated.replace(config)
    stdout, stderr = process.communicate(timeout=8)
    assert process.returncode == 0, stderr
    privacy_report = json.loads(stdout)
    assert privacy_report['checkpoint_writes'] >= 5 and privacy_report['checkpoint_ordinary_writes'] == 0, 'privacy reset and replacement upload force saves before ten seconds'
    private_state = json.loads((root/'window-cache.json').read_text())
    assert private_state['session_id'] != previous_session
    assert json.loads(private_state['fingerprint'])['privacy'] == settings['privacy']
    assert private_state['events'] == [] and private_state['baseline']['active_app'] is None
    assert private_state['baseline']['music']['state'] == 'unavailable' and 'running_apps' not in private_state['baseline']
    assert len(received) == 2 and received[-1][1]['session_id'] == private_state['session_id']
    assert received[-1][1]['baseline']['active_app'] is None and not received[-1][1]['events']
    assert not private_state['dropped_events']

    # Invoke the real sleep/wake selectors locally. Any late task callback would
    # inject a synthetic forbidden value; no real system sleep is requested.
    (root/'window-cache.json').unlink()
    sleep_source = (REPO/'agent/window-runtime.js').read_text()
    sleep_setup = r'''
  var fixturePhase = 0;
  ['music','hardware','artwork','upload'].forEach(function(key) {
    launch(key, '/bin/sleep', ['1'], 5000, function() {
      observed({music:{state:'playing',track:'STALE',artist:'STALE'}},Date.now());
    });
  });
'''
    sleep_source = sleep_source.replace('  flush();\n  try {', sleep_setup+'\n  flush();\n  try {')
    sleep_stimulus = r'''
      if (fixturePhase === 0 && now - began >= 200) {
        observer.willSleep(undefined);
        if (Object.keys(tasks).length) throw new Error('Sleep retained an in-flight task');
        fixturePhase = 1;
      } else if (fixturePhase === 1 && now - began >= 600) {
        observer.didWake(undefined); fixturePhase = 2;
      }
'''
    sleep_source = sleep_source.replace('lastLoop = now; lastUptime = uptime; finishTasks(now);', 'lastLoop = now; lastUptime = uptime; finishTasks(now);'+sleep_stimulus)
    script.write_text(sleep_source)
    sleep_argv = [*argv[:-2], 'observe', '2']
    sleep_run = subprocess.run(sleep_argv, capture_output=True, text=True, timeout=5)
    assert sleep_run.returncode == 0, sleep_run.stderr
    sleep_report = json.loads(sleep_run.stdout)
    assert sleep_report['checkpoint_writes'] == 4 and sleep_report['checkpoint_ordinary_writes'] == 0, 'startup, sleep, wake and final exit force saves'
    slept = json.loads((root/'window-cache.json').read_text())
    assert any(gap['reason'] == 'sleep' for gap in slept['gaps'])
    assert slept['current']['music']['state'] == 'unavailable'

    # A failed collector or malformed successful output is an immediate durable
    # boundary even when its unknown values equal the already-unknown snapshot.
    settings['privacy']['battery'] = True; settings['privacy']['system'] = True
    config.write_text(json.dumps(settings)); config.chmod(0o600)
    for command in ["'/usr/bin/false', []", "'/bin/echo', ['{malformed']"]:
        (root/'window-cache.json').unlink()
        failure_source = (REPO/'agent/window-runtime.js').read_text()
        needle = "launch('hardware', '/usr/bin/osascript', ['-l', 'JavaScript', args[0], 'collect', capturedConfig], 6000,"
        assert needle in failure_source
        failure_source = failure_source.replace(needle, "launch('hardware', "+command+", 6000,")
        script.write_text(failure_source)
        failed = subprocess.run(sleep_argv, capture_output=True, text=True, timeout=5)
        assert failed.returncode == 0, failed.stderr
        failed_report = json.loads(failed.stdout)
        assert failed_report['checkpoint_writes'] == 3 and failed_report['checkpoint_ordinary_writes'] == 0
        failed_state = json.loads((root/'window-cache.json').read_text())
        assert failed_state['events'] == [] and failed_state['gaps'][0]['reason'] == 'collection'
        assert failed_state['current']['system'] == {'load_1m': None, 'load_5m': None, 'load_15m': None}

server.shutdown()


def cadence_case(kind):
    # Run real elapsed-time native loops in separate temporary directories. A
    # duplicate notification must not turn the idle 30-second heartbeat into a
    # 10-second dirty checkpoint. No Music events leave this process.
    with tempfile.TemporaryDirectory(prefix='macflare-cadence-'+kind+'-') as folder:
        root = pathlib.Path(folder)
        config = root/'config.json'
        config.write_text(json.dumps({'profile': 'buffered', 'privacy': {
            'active_app': False, 'running_apps': False, 'battery': False, 'system': False, 'music': True}}))
        config.chmod(0o600)
        cadence_source = (REPO/'agent/window-runtime.js').read_text()
        cadence_source = cadence_source.replace('if (now - lastMusic >= 2000) requestMusic(now);', '/* Fixture supplies local notifications only. */')
        cadence_source = cadence_source.replace('artwork(now); upload(now);', '/* No Apple or Worker requests in cadence fixtures. */')
        setup = r'''
  var fixtureSent = false, fixtureDuplicates = 0;
  function fixtureMusic(title) {
    observer.musicChanged($.NSNotification.notificationWithNameObjectUserInfo('com.apple.Music.playerInfo',undefined,
      $({'Player State':'Playing',Name:title,Artist:'Fixture Artist'})));
  }
'''
        if kind == 'idle':
            setup += "  fixtureMusic('Unchanged Fixture Song');\n"
        cadence_source = cadence_source.replace('  flush();\n  try {', setup+'\n  flush();\n  try {')
        if kind == 'burst':
            stimulus = r'''
      if (!fixtureSent && now - began >= 400) {
        for (var fixtureIndex = 0; fixtureIndex < 80; fixtureIndex += 1) fixtureMusic('Burst Song ' + fixtureIndex);
        for (var duplicate = 0; duplicate < 200; duplicate += 1) fixtureMusic('Burst Song 79');
        fixtureSent = true;
      }
'''
            duration = '12'
        else:
            stimulus = "\n      fixtureMusic('Unchanged Fixture Song'); fixtureDuplicates += 1;\n"
            duration = '32'
        cadence_source = cadence_source.replace('lastLoop = now; lastUptime = uptime; finishTasks(now);', 'lastLoop = now; lastUptime = uptime; finishTasks(now);'+stimulus)
        script = root/'cadence.js'; script.write_text(cadence_source)
        argv = ['/usr/bin/osascript', '-l', 'JavaScript', str(script), str(REPO/'agent/runtime.js'), str(config), str(root/'unused-token'), str(root), 'observe', duration]
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 2
            while not (root/'window-cache.json').exists() and time.monotonic() < deadline:
                assert process.poll() is None
                time.sleep(0.05)
            first = (root/'window-cache.json').read_bytes()
            first_mtime = (root/'window-cache.json').stat().st_mtime_ns
            time.sleep(2)
            assert (root/'window-cache.json').stat().st_mtime_ns == first_mtime
            assert (root/'window-cache.json').read_bytes() == first, 'ordinary notifications must not save before ten seconds'
            stdout, stderr = process.communicate(timeout=int(duration)+3)
            assert process.returncode == 0, stderr
            report = json.loads(stdout)
            cached = json.loads((root/'window-cache.json').read_text())
            assert report['checkpoint_writes'] == 3 and report['checkpoint_ordinary_writes'] == 1, report
            assert report['uploads'] == 0 and report['dropped_events'] == 0
            if kind == 'burst':
                tracks = [event['changes']['music']['track'] for event in cached['events'] if 'music' in event['changes']]
                assert tracks == ['Burst Song '+str(index) for index in range(80)]
                assert report['notifications'] == 280 and cached['seq'] == 80
            else:
                assert report['notifications'] > 100 and cached['seq'] == 1
            return kind + ': ' + str(report['events']) + ' retained events, 1 ordinary checkpoint'
        finally:
            if process.poll() is None:
                process.terminate(); process.communicate(timeout=3)


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    cadence_results = list(pool.map(cadence_case, ['burst', 'idle']))
print('PASS: native rapid callbacks, slow-upload concurrency, private checkpoint and kernel lock, failed-upload retention, forced saves for privacy/upload/sleep/wake/exit, cancelled stale tasks; '+ '; '.join(cadence_results))
