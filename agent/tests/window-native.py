"""Native run-loop fixtures use only local fake notifications and a loopback server.
They never change focus, send Music Apple Events, or upload to the public Worker.
"""
import http.server
import datetime
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
    slept = json.loads((root/'window-cache.json').read_text())
    assert any(gap['reason'] == 'sleep' for gap in slept['gaps'])
    assert slept['current']['music']['state'] == 'unavailable'

server.shutdown()
print('PASS: native queued activation and rapid Music metadata callbacks, slow-upload concurrency, private atomic checkpoint, kernel single-writer lock/release, failed-upload retention, hot privacy purge and immediate replacement, sleep cancels stale tasks before fresh wake observations')
