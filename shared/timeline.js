/** Fixed protocol policy: local observation is independent from edge uploads. */
export const TIMELINE_POLICY = Object.freeze({
  upload_interval_seconds: 300,
  window_seconds: 900,
  playback_delay_seconds: 420,
  poll_interval_seconds: 60,
  sample_interval_seconds: 2,
  metrics_interval_seconds: 30,
});

const FIELDS = ["active_app", "running_apps", "battery", "system", "music"];

function copySnapshot(value) {
  return {
    schema_version: 1,
    collected_at: value.collected_at,
    active_app: value.active_app,
    ...(Object.hasOwn(value, "running_apps") ? { running_apps: [...value.running_apps] } : {}),
    battery: { ...value.battery },
    system: { ...value.system },
    music: { ...value.music },
  };
}

/**
 * Project a validated, self-contained window at the requested observation time.
 * Gaps are half-open [start, end); the final observed window endpoint is playable.
 * This never advances a state outside coverage or mutates the supplied window.
 */
export function replayWindow(batch, atMs) {
  const at = new Date(atMs).toISOString();
  const empty = (state) => ({ state, snapshot: null, at });
  if (!batch || batch.schema_version !== 2 || !batch.baseline
    || !Array.isArray(batch.events) || !Array.isArray(batch.gaps)) return empty("buffering");
  const start = Date.parse(batch.window_start);
  const end = Date.parse(batch.window_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || atMs < start || atMs > end) return empty("buffering");
  for (const gap of batch.gaps) {
    const gapStart = Date.parse(gap.start_at);
    if (gapStart > atMs) break;
    if (atMs < Date.parse(gap.end_at)) return empty("gap");
  }
  const snapshot = copySnapshot(batch.baseline);
  for (const event of batch.events) {
    if (Date.parse(event.at) > atMs) break;
    // Apply every event in sequence, including multiple changes at one timestamp.
    for (const field of FIELDS) {
      if (!Object.hasOwn(event.changes, field)) continue;
      const value = event.changes[field];
      snapshot[field] = Array.isArray(value) ? [...value]
        : value !== null && typeof value === "object" ? { ...value } : value;
    }
    snapshot.collected_at = event.at;
  }
  return { state: "playing", snapshot, at };
}
