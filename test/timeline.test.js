import test from "node:test";
import assert from "node:assert/strict";
import { TIMELINE_POLICY, replayWindow } from "../shared/timeline.js";

const START = Date.parse("2026-09-08T10:00:00.000Z");
const iso = (delta) => new Date(START + delta).toISOString();
function fixture() {
  return {
    schema_version: 2,
    session_id: "a791cf39-11f2-4ac7-9c08-ab0c5db561b0",
    batch_seq: 1,
    generated_at: iso(900_000), window_start: iso(0), window_end: iso(900_000),
    baseline: {
      schema_version: 1, collected_at: iso(0), active_app: "Finder", running_apps: ["Finder", "Music"],
      battery: { percent: 80, charging: true, power_source: "ac" },
      system: { load_1m: 1, load_5m: 1, load_15m: 1 },
      music: { state: "stopped", track: null, artist: null },
    },
    events: [], gaps: [], dropped_events: 0,
  };
}

function deepFreeze(object) {
  Object.freeze(object);
  for (const value of Object.values(object)) if (value && typeof value === "object") deepFreeze(value);
  return object;
}

test("timeline policy fixes independent collection, upload, playback, and polling intervals", () => {
  assert.equal(Object.isFrozen(TIMELINE_POLICY), true);
  assert.deepEqual(TIMELINE_POLICY, {
    upload_interval_seconds: 300, window_seconds: 900, playback_delay_seconds: 420,
    poll_interval_seconds: 60, sample_interval_seconds: 2, metrics_interval_seconds: 30,
  });
});

test("every observed rapid song and app switch is replayable in timestamp order", () => {
  const batch = fixture();
  batch.events = Array.from({ length: 100 }, (_, index) => ({
    seq: index + 1, at: iso(1000 + index * 10),
    changes: { active_app: `App ${index}`, music: { state: "playing", track: `Song ${index}`, artist: "Artist" } },
  }));
  for (let index = 0; index < batch.events.length; index += 1) {
    for (const offset of [0, 9]) {
      const replay = replayWindow(batch, START + 1000 + index * 10 + offset);
      assert.equal(replay.state, "playing");
      assert.equal(replay.snapshot.music.track, `Song ${index}`);
      assert.equal(replay.snapshot.active_app, `App ${index}`);
      assert.equal(replay.snapshot.collected_at, batch.events[index].at);
    }
  }
  assert.equal(replayWindow(batch, START + 999).snapshot.active_app, "Finder");
});

test("same-time patches all apply in sequence and replace complete fields", () => {
  const batch = fixture();
  batch.events = [
    { seq: 1, at: iso(1000), changes: { active_app: "Safari", music: { state: "playing", track: "First", artist: "Artist", artwork_url: "https://is1-ssl.mzstatic.com/a.jpg", track_url: "https://music.apple.com/song/1" } } },
    { seq: 2, at: iso(1000), changes: { active_app: "Music", music: { state: "stopped", track: null, artist: null } } },
    { seq: 3, at: iso(1000), changes: { running_apps: [], battery: { percent: null, charging: null, power_source: "unknown" } } },
  ];
  const replay = replayWindow(batch, START + 1000);
  assert.equal(replay.snapshot.active_app, "Music");
  assert.deepEqual(replay.snapshot.running_apps, []);
  assert.deepEqual(replay.snapshot.music, { state: "stopped", track: null, artist: null });
  assert.deepEqual(replay.snapshot.battery, { percent: null, charging: null, power_source: "unknown" });
});

test("coverage does not extrapolate and collection gaps are half-open", () => {
  const batch = fixture();
  batch.gaps = [{ start_at: iso(1000), end_at: iso(2000), reason: "sleep" }];
  batch.events = [{ seq: 1, at: iso(2000), changes: { active_app: "Music" } }];
  for (const at of [-1, 900_001]) {
    assert.deepEqual(replayWindow(batch, START + at), { state: "buffering", snapshot: null, at: iso(at) });
  }
  for (const at of [1000, 1500, 1999]) {
    assert.deepEqual(replayWindow(batch, START + at), { state: "gap", snapshot: null, at: iso(at) });
  }
  for (const at of [0, 999, 2000, 900_000]) assert.equal(replayWindow(batch, START + at).state, "playing");
  assert.equal(replayWindow(batch, START + 2000).snapshot.active_app, "Music");
});

test("a subsequent overlapping complete window recovers all retained transitions without the previous response", () => {
  const first = fixture();
  first.events = [
    { seq: 1, at: iso(60_000), changes: { active_app: "Safari" } },
    { seq: 2, at: iso(420_000), changes: { active_app: "Music", music: { state: "playing", track: "A", artist: "Artist" } } },
    { seq: 3, at: iso(550_000), changes: { music: { state: "playing", track: "B", artist: "Artist" } } },
    { seq: 4, at: iso(800_000), changes: { active_app: "Terminal" } },
  ];
  const second = structuredClone(first);
  second.batch_seq = 2;
  second.window_start = iso(300_000);
  second.window_end = second.generated_at = iso(1_200_000);
  second.baseline = { ...replayWindow(first, START + 300_000).snapshot, collected_at: second.window_start };
  second.events = second.events.filter((event) => Date.parse(event.at) > START + 300_000);
  for (let at = 300_000; at <= 900_000; at += 1000) {
    const a = replayWindow(first, START + at).snapshot;
    const b = replayWindow(second, START + at).snapshot;
    assert.deepEqual({ ...a, collected_at: null }, { ...b, collected_at: null });
  }
});

test("returned snapshots cannot mutate future playback or frozen input data", () => {
  const batch = fixture();
  batch.events = [{ seq: 1, at: iso(1), changes: { running_apps: ["Safari"], music: { state: "playing", track: "Song", artist: "Artist" } } }];
  deepFreeze(batch);
  const output = replayWindow(batch, START + 1);
  output.snapshot.running_apps.push("Changed");
  output.snapshot.music.track = "Changed";
  output.snapshot.battery.percent = 0;
  const next = replayWindow(batch, START + 1);
  assert.deepEqual(next.snapshot.running_apps, ["Safari"]);
  assert.equal(next.snapshot.music.track, "Song");
  assert.equal(next.snapshot.battery.percent, 80);
});

test("absent or uncovered windows never produce a fabricated snapshot", () => {
  for (const batch of [null, {}, { schema_version: 1 }, { ...fixture(), window_end: "invalid" }]) {
    assert.deepEqual(replayWindow(batch, START), { state: "buffering", snapshot: null, at: iso(0) });
  }
});
