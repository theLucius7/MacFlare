import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowPresentation } from '../shared/presentation.js';

const music = (track = 'First', state = 'playing') => ({ state, track, artist: 'Artist' });
const view = (changes = {}) => ({state:'playing',mode:'window',at:'2026-09-09T00:00:00.000Z',
  delaySeconds:420, snapshot:{schema_version:1,collected_at:'2026-09-09T00:00:00.000Z',
    active_app:'Finder',running_apps:['Finder'],music:music(),
    battery:{percent:80,charging:false,power_source:'battery'},system:{load_1m:1,load_5m:1,load_15m:1},...changes}});

test('bursts keep the latest display candidate without modifying raw source events or delaying the playhead', () => {
  const display = new WindowPresentation();
  display.view(view(),0,'session');
  const source = view({active_app:'Code',music:music('Second')});
  const unchanged = structuredClone(source);
  assert.equal(display.view(source,100,'session').snapshot.active_app,'Finder');
  assert.deepEqual(source,unchanged);
  const latest = view({active_app:'Music',music:music('Third')});
  assert.equal(display.view(latest,1999,'session').snapshot.music.track,'First');
  const released = display.view(latest,2000,'session');
  assert.equal(released.snapshot.active_app,'Music');
  assert.equal(released.snapshot.music.track,'Third');
  assert.equal(released.at,latest.at);
  assert.equal(released.delaySeconds,420);
  assert.equal(display.view(view({active_app:'Terminal'}),2001,'session').snapshot.active_app,'Music');
  assert.equal(display.view(view({active_app:'Terminal'}),4000,'session').snapshot.active_app,'Terminal');
});

test('returning to the displayed value cancels a transient switch and continuous bursts cannot starve updates', () => {
  const display = new WindowPresentation();
  display.view(view(),0,'session');
  display.view(view({active_app:'Code'}),500,'session');
  assert.equal(display.view(view(),2000,'session').snapshot.active_app,'Finder');
  let transitions = 0, previous = 'Finder';
  for (let now=2100;now<=10000;now+=100) {
    const current=display.view(view({active_app:`App ${now}`}),now,'session').snapshot.active_app;
    if(current!==previous) transitions++;
    previous=current;
  }
  assert.equal(transitions,4);
});

test('privacy clearing, app removal, missing fields and unavailable music bypass display holds', () => {
  const display = new WindowPresentation();
  display.view(view({running_apps:['Finder','Private']}),0,'session');
  let shown=display.view(view({active_app:'System',running_apps:['Finder'],music:music(null,'unavailable')}),1,'session');
  assert.equal(shown.snapshot.active_app,'System');
  assert.deepEqual(shown.snapshot.running_apps,['Finder']);
  assert.equal(shown.snapshot.music.track,null);
  const missing=view({active_app:null}); delete missing.snapshot.running_apps;
  shown=display.view(missing,2,'session');
  assert.equal(shown.snapshot.active_app,null);
  assert.equal(Object.hasOwn(shown.snapshot,'running_apps'),false);
});

test('cover backfills do not reset cadence and artwork never crosses song identity', () => {
  const display = new WindowPresentation();
  display.view(view(),0,'session');
  const first={...music(),artwork_url:'https://is1-ssl.mzstatic.com/first',track_url:'https://music.apple.com/first'};
  assert.equal(display.view(view({music:first}),1900,'session').snapshot.music.artwork_url,first.artwork_url);
  const second=music('Second');
  assert.deepEqual(display.view(view({music:second}),2000,'session').snapshot.music,second);
});

test('privacy clearing cancels old candidates and subsequent updates use only the latest source', () => {
  const display=new WindowPresentation();
  display.view(view(),0,'one');
  display.view(view({active_app:'Old candidate',music:music('Old candidate')}),100,'one');
  const cleared=view({active_app:'System',music:{state:'stopped',track:null,artist:null}});
  display.view(cleared,200,'one');
  const latest=view({active_app:'Latest',music:music('Latest')});
  const held=display.view(latest,2199,'one');
  assert.equal(held.snapshot.active_app,'System');
  assert.equal(held.snapshot.music.state,'stopped');
  const released=display.view(latest,2200,'one');
  assert.equal(released.snapshot.active_app,'Latest');
  assert.equal(released.snapshot.music.track,'Latest');
});

test('offline, gaps, buffering and session changes discard held private state immediately', () => {
  for(const state of ['offline','gap','buffering']) {
    const display=new WindowPresentation();
    display.view(view(),0,'one');
    const empty={state,snapshot:null};
    assert.deepEqual(display.view(empty,1,'one'),empty);
    assert.equal(display.shown,null);
    assert.equal(display.view(view({active_app:'New'}),2,'one').snapshot.active_app,'New');
  }
  const display=new WindowPresentation();
  display.view(view(),0,'one');
  assert.equal(display.view(view({active_app:'New'}),1,'two').snapshot.active_app,'New');
  assert.equal(display.view(view({active_app:'Clock'}),0,'two').snapshot.active_app,'Clock');
});

test('device values remain as recorded, legacy snapshots bypass smoothing, and returned copies are isolated', () => {
  const display=new WindowPresentation();
  display.view(view(),0,'one');
  const raw=view({battery:{percent:79,charging:true,power_source:'ac'},system:{load_1m:3,load_5m:2,load_15m:1}});
  const shown=display.view(raw,1,'one');
  assert.deepEqual(shown.snapshot.battery,raw.snapshot.battery);
  assert.deepEqual(shown.snapshot.system,raw.snapshot.system);
  shown.snapshot.music.track='mutation';
  assert.equal(display.view(raw,2,'one').snapshot.music.track,'First');
  const legacy={...view({active_app:'Legacy'}),mode:'snapshot'};
  assert.equal(display.view(legacy,3,'one').snapshot.active_app,'Legacy');
  assert.equal(display.shown,null);
});
