import { TIMELINE_POLICY, replayWindow } from './timeline.js';

const finiteDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// A browser keeps one bounded window in memory. All elapsed time comes from the
// monotonic clock supplied by the caller, so changing the viewer's clock cannot
// fast-forward a song or revive an expired window.
export class WindowPlayback {
  constructor() {
    this.response = null;
    this.cursor = null;
    this.lastTick = null;
    this.received = null;
    this.server = null;
    this.recoveredGap = false;
    this.watermark = null;
  }

  accept(response, monotonicNow) {
    if (!response || !['online', 'offline'].includes(response.status)) throw new Error('Invalid timeline response');
    if (response.status === 'offline') {
      // An authoritative offline response also honors explicit data removal.
      this.response = null;
      this.lastTick = monotonicNow;
      return true;
    }
    if (!finiteDate(response.server_time) || !finiteDate(response.updated_at) || !finiteDate(response.expires_at)
      || !['window', 'snapshot'].includes(response.mode)) throw new Error('Invalid timeline envelope');
    if (response.mode === 'window') {
      const batch = response.window;
      if (!batch || batch.schema_version !== 2 || typeof batch.session_id !== 'string'
        || !Number.isSafeInteger(batch.batch_seq) || !finiteDate(batch.window_start) || !finiteDate(batch.window_end)
        || !batch.baseline || !Array.isArray(batch.events) || batch.events.length > 2048
        || !Array.isArray(batch.gaps) || batch.gaps.length > 128) throw new Error('Invalid timeline window');
    } else if (!response.battery || !response.music || !response.system) {
      throw new Error('Invalid snapshot');
    }
    const previous = this.response || this.watermark;
    if (previous) {
      // Different KV locations can briefly return older versions. Keep the
      // accepted watermark, even when a response comes from another session.
      if (Date.parse(response.updated_at) < Date.parse(previous.updated_at)) return false;
      if (response.mode === 'window' && previous.mode === 'window'
        && response.window.session_id === previous.window.session_id
        && (response.window.batch_seq < previous.window.batch_seq
          || Date.parse(response.window.window_end) < Date.parse(previous.window.window_end))) return false;
    }
    // Advance against the old window before replacing it; a network request must
    // never create a jump over the part of the window that was buffering.
    this.view(monotonicNow);
    const sameSession = response.mode === 'window' && previous?.mode === 'window'
      && response.window.session_id === previous.window.session_id;
    const previousServerNow = this.server === null ? -Infinity
      : this.server + Math.max(0, monotonicNow - this.received);
    this.response = response;
    this.watermark = { mode: response.mode, updated_at: response.updated_at,
      ...(response.mode === 'window' ? { window: {
        session_id: response.window.session_id, batch_seq: response.window.batch_seq,
        window_start: response.window.window_start, window_end: response.window.window_end,
      } } : {}) };
    this.received = monotonicNow;
    this.server = Math.max(previousServerNow, Date.parse(response.server_time));
    this.lastTick = monotonicNow;
    if (response.mode === 'window') {
      const start = Date.parse(response.window.window_start);
      const end = Date.parse(response.window.window_end);
      if (!sameSession || this.cursor === null) {
        this.cursor = Math.min(this.server - TIMELINE_POLICY.playback_delay_seconds * 1000, end);
        this.recoveredGap = false;
      } else if (this.cursor < start && Date.parse(previous.window.window_start) <= this.cursor) {
        // An outage longer than retention cannot be recovered. State the loss
        // explicitly and resume at the earliest retained instant, not at 'now'.
        this.cursor = start;
        this.recoveredGap = true;
      }
    } else {
      this.cursor = null;
      this.recoveredGap = false;
    }
    return true;
  }

  view(monotonicNow) {
    const response = this.response;
    const elapsed = this.lastTick === null ? 0 : Math.max(0, monotonicNow - this.lastTick);
    this.lastTick = monotonicNow;
    if (!response) return { state: 'offline', snapshot: null, serverNow: null };
    const serverNow = this.server + Math.max(0, monotonicNow - this.received);
    if (serverNow >= Date.parse(response.expires_at)) {
      // Keep the watermark until a newer response arrives, but expose no data.
      return { state: 'offline', snapshot: null, serverNow };
    }
    if (response.mode === 'snapshot') return { state: 'playing', snapshot: response, serverNow, mode: 'snapshot' };
    const end = Date.parse(response.window.window_end);
    const target = serverNow - TIMELINE_POLICY.playback_delay_seconds * 1000;
    this.cursor = Math.min(end, Math.max(this.cursor, Math.min(this.cursor + elapsed, target)));
    const result = replayWindow(response.window, this.cursor);
    // The final instant is covered, but must not be held indefinitely as if the
    // Mac were still observed. Stop at the edge until a new window extends it.
    const exhausted = this.cursor >= end && target > end;
    return {
      ...result,
      state: exhausted ? 'buffering' : result.state,
      snapshot: exhausted ? null : result.snapshot,
      mode: 'window',
      serverNow,
      delaySeconds: Math.max(0, Math.round((serverNow - this.cursor) / 1000)),
      bufferedSeconds: Math.max(0, Math.floor((end - this.cursor) / 1000)),
      warmingSeconds: Math.max(0, Math.ceil((Date.parse(response.window.window_start) - this.cursor) / 1000)),
      recoveredGap: this.recoveredGap,
      droppedEvents: response.window.dropped_events,
      eventCount: response.window.events.length,
    };
  }
}
