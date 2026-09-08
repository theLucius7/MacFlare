/** Presentation cadence does not alter the recorded timeline or its playhead. */
export const PRESENTATION_INTERVAL_MS = 2000;

const FIELDS = ['active_app', 'music', 'running_apps'];
const copy = value => value === undefined ? undefined : structuredClone(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const song = value => JSON.stringify([value?.state, value?.track, value?.artist]);

function clearImmediately(field, next, previous) {
  if (field === 'active_app') return next == null || next === 'System';
  if (field === 'music') return !next || ['stopped', 'unavailable'].includes(next.state)
    || !next.track || !next.artist;
  // A removed app may have been hidden by privacy settings. Never hold it on
  // screen while waiting for the ordinary addition/switch cadence.
  return !Array.isArray(next) || !next.length
    || (Array.isArray(previous) && previous.some(name => !next.includes(name)));
}

export class WindowPresentation {
  constructor() { this.clear(); }

  clear() {
    this.session = null;
    this.shown = null;
    this.changedAt = {};
    this.lastNow = null;
  }

  view(raw, monotonicNow, session) {
    if (!Number.isFinite(monotonicNow)) throw new TypeError('A finite monotonic time is required');
    if (raw?.state !== 'playing' || raw.mode !== 'window' || !raw.snapshot) {
      this.clear();
      return raw;
    }
    const next = copy(raw.snapshot);
    if (!this.shown || session !== this.session || monotonicNow < this.lastNow) {
      this.shown = copy(next);
      this.session = session;
      for (const field of FIELDS) this.changedAt[field] = monotonicNow;
    }
    this.lastNow = monotonicNow;
    const held = [];
    for (const field of FIELDS) {
      const incoming = next[field], previous = this.shown[field];
      if (equal(incoming, previous)) continue;
      // Cover backfills for the displayed song are safe to show immediately;
      // a different song can never borrow the previous song's artwork.
      const metadataOnly = field === 'music' && song(incoming) === song(previous);
      if (metadataOnly || clearImmediately(field, incoming, previous)
        || monotonicNow - this.changedAt[field] >= PRESENTATION_INTERVAL_MS) {
        if (!metadataOnly) this.changedAt[field] = monotonicNow;
      } else {
        next[field] = copy(previous);
        held.push(field);
      }
    }
    this.shown = copy(next);
    return { ...raw, snapshot: next,
      presentation: { interval_ms: PRESENTATION_INTERVAL_MS, held_fields: held } };
  }
}
