const ANGLE_BINS = 32;
const MAX_BUTTONS = 256;

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value)));
}

function emptyDrift() {
  return { samples: 0, meanX: 0, meanY: 0, m2: 0, radiusSum: 0, peak: 0 };
}

function addDrift(stats, x, y) {
  stats.samples += 1;
  const dx = x - stats.meanX;
  const dy = y - stats.meanY;
  stats.meanX += dx / stats.samples;
  stats.meanY += dy / stats.samples;
  // Welford's algorithm retains precision for small movement around a center.
  stats.m2 += dx * (x - stats.meanX) + dy * (y - stats.meanY);
  const radius = Math.hypot(x, y);
  stats.radiusSum += radius;
  stats.peak = Math.max(stats.peak, radius);
}

function describeDrift(stats) {
  return {
    meanX: stats.meanX,
    meanY: stats.meanY,
    offset: stats.samples ? stats.radiusSum / stats.samples : 0,
    peak: stats.peak,
    jitter: stats.samples ? Math.sqrt(Math.max(0, stats.m2 / stats.samples)) : 0,
    samples: stats.samples,
  };
}

function emptyCircularity() {
  return { bins: new Array(ANGLE_BINS).fill(null), samples: 0 };
}

function addCircularity(stats, x, y) {
  const radius = Math.hypot(x, y);
  if (radius <= 0.5) return;
  const angle = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  const bin = Math.min(ANGLE_BINS - 1, Math.floor(angle / (Math.PI * 2) * ANGLE_BINS));
  stats.bins[bin] = Math.max(stats.bins[bin] ?? 0, radius);
  stats.samples += 1;
}

function describeCircularity(stats) {
  const populated = stats.bins.filter((radius) => radius !== null);
  return {
    coverage: populated.length / ANGLE_BINS,
    error: populated.length
      ? populated.reduce((sum, radius) => sum + Math.abs(radius - 1), 0) / populated.length
      : 0,
    samples: stats.samples,
  };
}

function sampleStamp(snapshot) {
  if (typeof snapshot.sampleId === 'string' || Number.isFinite(snapshot.sampleId)) {
    return `id:${snapshot.sampleId}`;
  }
  // Some Gamepad implementations always return zero, which cannot identify a
  // fresh report. With no usable report identity, count browser observations.
  if (Number.isFinite(snapshot.timestamp) && snapshot.timestamp > 0) {
    return `time:${snapshot.timestamp}`;
  }
  return null;
}

/** Browser-observed input statistics; these do not measure hardware latency. */
export class TestSession {
  constructor() {
    this.reset(null);
  }

  reset(deviceKey, buttonCount = 17) {
    this.deviceKey = deviceKey;
    this.buttonCount = Math.floor(clamp(buttonCount, 0, MAX_BUTTONS));
    this.buttonsTested = new Set();
    this.buttonPresses = 0;
    this.totalSamples = 0;
    this._previousButtons = [];
    this._startedAt = null;
    this._lastNow = 0;
    this._sampleStamp = null;
    this._supported = false;
    this._resetStickMetrics();
  }

  _resetStickMetrics() {
    this._drift = {
      state: 'idle', startedAt: 0, durationMs: 3000,
      left: emptyDrift(), right: emptyDrift(),
    };
    this._circularity = { left: emptyCircularity(), right: emptyCircularity() };
  }

  _clock(nowMs) {
    this._lastNow = Math.max(this._lastNow, finite(nowMs, this._lastNow));
    return this._lastNow;
  }

  _advanceDrift(nowMs) {
    if (this._drift.state === 'measuring'
        && nowMs >= this._drift.startedAt + this._drift.durationMs) {
      this._drift.state = 'complete';
    }
  }

  /** Returns false until a device with a standard stick mapping is observed. */
  startDrift(nowMs, durationMs = 3000) {
    const now = this._clock(nowMs);
    if (!this._supported) return false;
    this._drift = {
      state: 'measuring', startedAt: now,
      durationMs: clamp(finite(durationMs, 3000), 1, 60000),
      left: emptyDrift(), right: emptyDrift(),
    };
    return true;
  }

  update(snapshot, nowMs) {
    if (!snapshot || typeof snapshot !== 'object') return this.getSummary(nowMs);
    const buttons = Array.isArray(snapshot.buttons) ? snapshot.buttons.slice(0, MAX_BUTTONS) : [];
    const key = snapshot.key ?? this.deviceKey;
    if (key !== this.deviceKey) this.reset(key, buttons.length);
    const now = this._clock(nowMs);
    const supported = snapshot.mapping === 'standard';
    if (supported !== this._supported) {
      this._supported = supported;
      this._resetStickMetrics();
    }
    this._advanceDrift(now);

    const stamp = sampleStamp(snapshot);
    if (stamp !== null && stamp === this._sampleStamp) return this.getSummary(now);
    this._sampleStamp = stamp;
    if (this._startedAt === null) this._startedAt = now;
    this.totalSamples += 1;
    this.buttonCount = buttons.length;
    const pressed = buttons.map((button, index) => {
      const down = button?.pressed === true || clamp(button?.value, 0, 1) > 0.5;
      if (down && !this._previousButtons[index]) {
        this.buttonPresses += 1;
        this.buttonsTested.add(index);
      }
      return down;
    });
    this._previousButtons = pressed;

    if (supported) {
      const axes = Array.isArray(snapshot.axes) ? snapshot.axes : [];
      for (const [stick, offset] of [['left', 0], ['right', 2]]) {
        // Invalid or missing axis pairs are excluded rather than making an
        // unavailable stick appear perfectly centered in a measurement.
        if (!Number.isFinite(axes[offset]) || !Number.isFinite(axes[offset + 1])) continue;
        const x = clamp(axes[offset], -1, 1);
        const y = clamp(axes[offset + 1], -1, 1);
        addCircularity(this._circularity[stick], x, y);
        if (this._drift.state === 'measuring' && now >= this._drift.startedAt) {
          addDrift(this._drift[stick], x, y);
        }
      }
    }
    return this.getSummary(now);
  }

  getSummary(nowMs) {
    const now = this._clock(nowMs);
    this._advanceDrift(now);
    const drift = this._drift;
    const elapsed = drift.state === 'idle' ? 0 : Math.max(0, now - drift.startedAt);
    return {
      buttonsTested: [...this.buttonsTested].sort((a, b) => a - b),
      buttonCount: this.buttonCount,
      buttonPresses: this.buttonPresses,
      totalSamples: this.totalSamples,
      elapsedMs: this._startedAt === null ? 0 : Math.max(0, now - this._startedAt),
      drift: {
        supported: this._supported,
        state: drift.state,
        progress: drift.state === 'idle' ? 0 : Math.min(1, elapsed / drift.durationMs),
        remainingMs: drift.state === 'idle' ? 0 : Math.max(0, drift.durationMs - elapsed),
        left: describeDrift(drift.left),
        right: describeDrift(drift.right),
      },
      circularity: {
        supported: this._supported,
        left: describeCircularity(this._circularity.left),
        right: describeCircularity(this._circularity.right),
      },
    };
  }
}
