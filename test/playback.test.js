import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowPlayback } from '../shared/playback.js';

const origin = Date.parse('2026-09-09T01:00:00Z');
const iso = seconds => new Date(origin + seconds * 1000).toISOString();
const snapshot = at => ({schema_version: 1, collected_at: iso(at), active_app: 'Finder', running_apps: ['Finder'],
  battery: {percent: 90, charging: false, power_source: 'battery'},
  system: {load_1m: 1, load_5m: 1, load_15m: 1}, music: {state: 'stopped', track: null, artist: null}});
function response({start=0, end=900, now=900, seq=1, session='00000000-0000-4000-8000-000000000001', events=[], gaps=[]}={}) {
  return {status:'online', mode:'window', server_time:iso(now), updated_at:iso(end), expires_at:iso(end+600),
    window:{schema_version:2, session_id:session, batch_seq:seq, generated_at:iso(end), window_start:iso(start), window_end:iso(end),
      baseline:snapshot(start), events, gaps, dropped_events:0}};
}

test('first launch warms for the delay and then begins the observed baseline', () => {
  const player = new WindowPlayback();
  player.accept(response({end:0,now:0}), 0);
  assert.equal(player.view(0).state,'buffering');
  assert.equal(player.view(0).warmingSeconds,420);
  player.accept(response({end:300,now:300,seq:2}), 300000);
  assert.equal(player.view(419000).state,'buffering');
  assert.equal(player.view(420000).snapshot.active_app,'Finder');
});

test('playback follows rapid app and song changes in order inside one uploaded window', () => {
  const player = new WindowPlayback();
  const events = [
    {seq:1,at:iso(481),changes:{active_app:'Code'}},
    {seq:2,at:iso(481.1),changes:{music:{state:'playing',track:'First',artist:'Artist'}}},
    {seq:3,at:iso(481.3),changes:{music:{state:'playing',track:'Second',artist:'Artist'}}},
    {seq:4,at:iso(482),changes:{active_app:'Music'}}
  ];
  player.accept(response({events}),0);
  assert.equal(player.view(1000).snapshot.active_app,'Code');
  assert.equal(player.view(1100).snapshot.music.track,'First');
  assert.equal(player.view(1300).snapshot.music.track,'Second');
  assert.equal(player.view(2000).snapshot.active_app,'Music');
});

test('older KV responses and repeated batches cannot rewind the playhead', () => {
  const player = new WindowPlayback();
  player.accept(response({seq:2}),0);
  const first = player.view(3000).at;
  assert.equal(player.accept(response({seq:1}),4000),false);
  assert.equal(player.accept(response({end:600,now:910,session:'00000000-0000-4000-8000-000000000002'}),5000),false);
  player.accept(response({seq:2,now:905}),5000);
  assert.ok(Date.parse(player.view(5000).at)>=Date.parse(first));
});

test('network outage drains covered data, waits, and resumes without skipping recoverable events', () => {
  const player = new WindowPlayback();
  player.accept(response(),0);
  assert.equal(player.view(419000).state,'playing');
  assert.equal(player.view(430000).state,'buffering');
  player.accept(response({start:300,end:1200,now:1340,seq:2,events:[{seq:10,at:iso(901),changes:{active_app:'Music'}}]}),440000);
  assert.equal(player.view(441000).snapshot.active_app,'Music');
  assert.ok(player.view(441000).delaySeconds>420);
});

test('an unrecoverable gap resumes at the oldest retained point and explicitly reports loss', () => {
  const player = new WindowPlayback();
  player.accept(response(),0);
  player.view(700000);
  player.accept(response({start:1200,end:2100,now:2100,seq:2}),1200000);
  const view = player.view(1200000);
  assert.equal(view.at,iso(1200));
  assert.equal(view.recoveredGap,true);
});

test('sleep gaps hide data, new sessions clear old content, and absolute expiry is respected', () => {
  const player = new WindowPlayback();
  player.accept(response({gaps:[{start_at:iso(479),end_at:iso(490),reason:'sleep'}]}),0);
  assert.equal(player.view(0).state,'gap');
  assert.equal(player.view(0).snapshot,null);
  player.accept(response({start:901,end:901,now:901,session:'00000000-0000-4000-8000-000000000002'}),1000);
  assert.equal(player.view(1000).state,'buffering');
  assert.equal(player.view(601000).state,'offline');
  player.accept({status:'offline'},602000);
  assert.equal(player.view(602000).snapshot,null);
});

test('legacy snapshots still display and malformed or oversized envelopes are rejected', () => {
  const player = new WindowPlayback();
  const legacy = {...snapshot(900),status:'online',mode:'snapshot',server_time:iso(900),updated_at:iso(900),expires_at:iso(1080)};
  player.accept(legacy,1000);
  assert.equal(player.view(1000).mode,'snapshot');
  assert.equal(player.view(181000).state,'offline');
  assert.throws(()=>player.accept({...response(),server_time:'bad'},0));
  const oversized = response(); oversized.window.events=Array(2049).fill({});
  assert.throws(()=>player.accept(oversized,0));
});

test('an offline response retains only a watermark so later stale data cannot replay backward', () => {
  const player = new WindowPlayback();
  player.accept(response({seq:2}),0);
  const before = player.view(5000).at;
  player.accept({status:'offline'},6000);
  assert.equal(player.view(6000).snapshot,null);
  assert.equal(player.accept(response({seq:1}),7000),false);
  player.accept(response({seq:2,now:906}),7000);
  assert.ok(Date.parse(player.view(7000).at)>=Date.parse(before));
  assert.equal('baseline' in player.watermark.window,false);
});

test('small server-clock adjustments never move an accepted playhead backward', () => {
  const player = new WindowPlayback();
  player.accept(response(),0);
  const before = player.view(5000).at;
  player.accept(response({now:904.9}),5000);
  assert.equal(player.view(5000).at,before);
});

test('a delayed duplicate response cannot extend the absolute expiry by resetting the server clock', () => {
  const player = new WindowPlayback();
  player.accept(response(),0);
  player.view(599000);
  player.accept(response({now:901}),599000);
  assert.equal(player.view(600000).state,'offline');
});
