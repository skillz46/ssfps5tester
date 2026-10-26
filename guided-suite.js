const DEFINITIONS = [
  ['buttons', 'Buttons', 'Press every listed button. Home / PS may be reserved by your system; you can skip this check.'],
  ['sticks', 'Analog sticks', 'Sweep both sticks around their full edge, then release both to the center.'],
  ['triggers', 'Analog triggers', 'Fully squeeze both triggers, then release both.'],
  ['drift', 'Stick center', 'Leave both sticks untouched for the three-second center observation.'],
  ['touchpad', 'Touchpad', 'Tap and release, slide a finger, use two fingers together, and click the touchpad.'],
  ['motion', 'Motion sensors', 'Gently rotate and tilt around each of the controller’s three axes until every gyro and acceleration axis responds.'],
  ['adaptiveTriggers', 'Adaptive triggers', 'Start a short resistance test, gently squeeze L2 and R2, then confirm both responded.'],
  ['lights', 'Controller lights', 'Run the light sequence and watch the RGB light bar, player 1–5 patterns, and microphone indicator. Confirm each supported light responded.'],
  ['vibration', 'Vibration', 'Run the vibration check, then confirm whether you felt both motors.'],
  ['speaker', 'Controller speaker', 'Choose the controller audio output, play a tone, and confirm where you heard it.'],
  ['microphone', 'Controller microphone', 'Choose the controller microphone, speak, and confirm its input signal.'],
  ['charging', 'Reported power state', 'Connect USB power. This check reads the reported charging state; it does not verify battery health.'],
];
const TERMINAL = new Set(['passed', 'needs-check', 'unsupported', 'skipped']);
const MANUAL = new Set(['adaptiveTriggers', 'lights', 'vibration', 'speaker', 'microphone']);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const bounded = value => finite(value) ? Math.max(0, Math.min(1, value)) : 0;
const clone = value => JSON.parse(JSON.stringify(value));
const down = value => value?.pressed === true || bounded(value?.value) > 0.5;
const vector = value => Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(finite);
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

/** A sequential observation guide. It never sends output or opens media devices. */
export class GuidedSuite {
  constructor() { this._initialize(); }

  _initialize() {
    this._state = 'idle';
    this._key = null;
    this._source = null;
    this._index = -1;
    this._now = 0;
    this._startedAt = null;
    this._endedAt = null;
    this._reason = '';
    this._snapshot = null;
    this._tracking = {};
    this._steps = DEFINITIONS.map(([id, label, instructions]) => ({
      id, label, instructions, status: 'pending', detail: '', progress: 0,
      allowSkip: true, manual: MANUAL.has(id), data: {},
    }));
  }

  _clock(now) { this._now = Math.max(this._now, finite(now) ? now : this._now); return this._now; }

  start(snapshot, now = 0) {
    this._initialize();
    this._clock(now);
    if (!snapshot || snapshot.key == null || !['hid', 'gamepad'].includes(snapshot.source)) {
      this._state = 'cancelled';
      this._reason = 'No controller input is available.';
      return this.getSummary();
    }
    this._key = snapshot.key;
    this._source = snapshot.source;
    this._snapshot = snapshot;
    this._state = 'running';
    this._startedAt = this._now;
    this._next();
    return this.update(snapshot, now);
  }

  _unsupported(id, snapshot) {
    if (id === 'buttons' && !snapshot.buttons?.length) return 'No button input is exposed.';
    if (['sticks', 'triggers', 'drift'].includes(id)) {
      if (snapshot.mapping !== 'standard') return 'This connection has no standard stick or trigger mapping.';
      if (id === 'triggers' && (snapshot.buttons?.length ?? 0) < 8) return 'Both analog triggers are not exposed.';
      if (id !== 'triggers' && (!Array.isArray(snapshot.axes) || snapshot.axes.length < 4 || !snapshot.axes.slice(0, 4).every(finite))) return 'Both stick axis pairs are not exposed.';
    }
    if (id === 'touchpad' && (snapshot.source !== 'hid' || !Array.isArray(snapshot.touches))) return 'Touchpad contacts need detailed PlayStation USB input.';
    if (id === 'motion' && (snapshot.source !== 'hid' || !vector(snapshot.motion?.gyro) || !vector(snapshot.motion?.accel))) return 'Motion readings need detailed PlayStation USB input.';
    if (id === 'adaptiveTriggers' && snapshot.adaptiveTriggers !== true) return 'Adaptive trigger output needs a compatible DualSense or DualSense Edge USB connection.';
    if (id === 'lights' && snapshot.lights !== true) return 'Controller light output needs a compatible DualSense or DualSense Edge USB connection.';
    if (id === 'vibration' && !snapshot.haptics) return 'Vibration is unavailable through this connection.';
    if (id === 'charging' && (snapshot.source !== 'hid' || !['charging', 'full', 'discharging', 'error', 'not-charging'].includes(snapshot.battery?.powerState))) return 'An explicit charging state is not exposed by this connection.';
    return '';
  }

  _next() {
    while (++this._index < this._steps.length) {
      const step = this._steps[this._index];
      const unavailable = this._unsupported(step.id, this._snapshot);
      if (unavailable) { Object.assign(step, { status: 'unsupported', detail: unavailable }); continue; }
      step.status = 'active';
      this._tracking = {};
      if (step.id === 'buttons') step.data = { required: Array.from({ length: this._snapshot.buttons.length }, (_, i) => i).filter(i => this._snapshot.mapping !== 'standard' || (i !== 6 && i !== 7)), tested: [] };
      if (step.id === 'sticks') {
        this._tracking.bins = [new Set(), new Set()];
        step.data = { left: { coverage: 0, centered: false, completed: false }, right: { coverage: 0, centered: false, completed: false } };
      }
      if (step.id === 'triggers') step.data = { left: { squeezed: false, released: false, completed: false }, right: { squeezed: false, released: false, completed: false } };
      if (step.id === 'drift') step.data = { measuringSeen: false };
      if (step.id === 'touchpad') {
        this._tracking.origins = new Map();
        step.data = { tap: false, movement: false, twoContacts: false, click: false, maxMovement: 0 };
      }
      if (step.id === 'motion') {
        const { gyro, accel } = this._snapshot.motion;
        this._tracking.base = { gyro: gyro.slice(0, 3), accel: accel.slice(0, 3) };
        this._tracking.min = { gyro: [...gyro], accel: [...accel] };
        this._tracking.max = { gyro: [...gyro], accel: [...accel] };
        step.data = { gyroRange: [0, 0, 0], accelRange: [0, 0, 0], gyroVariation: 0, accelVariation: 0 };
      }
      return;
    }
    this._state = 'complete';
    this._endedAt = this._now;
  }

  _finish(status, detail) {
    const step = this._steps[this._index];
    Object.assign(step, { status, detail });
    if (status === 'passed') step.progress = 1;
    this._next();
  }

  update(snapshot, now = this._now, extras = {}) {
    this._clock(now);
    if (this._state !== 'running') return this.getSummary();
    if (!snapshot) return this.cancel('Controller input stopped. Restart when live input returns.');
    if (snapshot.key !== this._key) return this.cancel('The selected controller changed. Restart the guide for this controller.');
    if (snapshot.source !== this._source) return this.cancel('The input source changed. Restart the guide.');
    this._snapshot = snapshot;
    const step = this._steps[this._index], data = step.data;
    const unsupported = this._unsupported(step.id, snapshot);
    if (unsupported) { this._finish('unsupported', unsupported); return this.getSummary(); }

    if (step.id === 'buttons') {
      for (const i of data.required) if (down(snapshot.buttons[i]) && !data.tested.includes(i)) data.tested.push(i);
      data.tested.sort((a, b) => a - b);
      step.progress = data.required.length ? data.tested.length / data.required.length : 1;
      if (step.progress === 1) this._finish('passed', 'Every listed digital button was observed pressed.');
    } else if (step.id === 'sticks') {
      for (const [side, offset] of [['left', 0], ['right', 2]]) {
        const radius = Math.hypot(snapshot.axes[offset], snapshot.axes[offset + 1]);
        const bins = this._tracking.bins[offset / 2];
        if (radius > 0.6) {
          const angle = (Math.atan2(snapshot.axes[offset + 1], snapshot.axes[offset]) + Math.PI * 2) % (Math.PI * 2);
          bins.add(Math.min(31, Math.floor(angle / (Math.PI * 2) * 32)));
        }
        data[side].coverage = bins.size / 32;
        data[side].centered = bins.size >= 26 && radius < 0.15;
        data[side].completed ||= data[side].centered;
      }
      step.progress = ['left', 'right'].reduce((sum, side) => sum + Math.min(1, data[side].coverage / 0.8) * 0.45 + (data[side].centered ? 0.05 : 0), 0);
      if (data.left.centered && data.right.centered) this._finish('passed', 'Both sticks covered the outer sweep and returned near center.');
    } else if (step.id === 'triggers') {
      for (const [side, i] of [['left', 6], ['right', 7]]) {
        const value = bounded(snapshot.buttons[i]?.value);
        if (value > 0.9) data[side].squeezed = true;
        data[side].released = data[side].squeezed && value < 0.1;
        data[side].completed ||= data[side].released;
      }
      step.progress = ['left', 'right'].reduce((sum, side) => sum + Number(data[side].squeezed) + Number(data[side].released), 0) / 4;
      if (data.left.released && data.right.released) this._finish('passed', 'Both analog triggers reached the high and released ranges.');
    } else if (step.id === 'drift') {
      const drift = extras?.drift;
      if (drift?.state === 'measuring') data.measuringSeen = true;
      if (drift?.supported !== false && data.measuringSeen) {
        step.progress = bounded(drift?.progress);
        if (drift?.state === 'complete') {
          data.left = clone(drift.left ?? {}); data.right = clone(drift.right ?? {});
          const usable = [data.left, data.right].every(side => side.samples > 0 && finite(side.offset));
          if (!usable) this._finish('needs-check', 'The center observation finished without usable samples for both sticks.');
          else {
            const offset = Math.max(data.left.offset, data.right.offset);
            this._finish(offset > 0.08 ? 'needs-check' : 'passed', `Observed mean radial displacement: ${(data.left.offset * 100).toFixed(1)}% left, ${(data.right.offset * 100).toFixed(1)}% right. This is a browser observation, not a calibration verdict.`);
          }
        }
      }
    } else if (step.id === 'touchpad') {
      const active = snapshot.touches.filter(touch => touch.active && finite(touch.x) && finite(touch.y));
      const ids = new Set(active.map(touch => touch.id));
      if (active.length >= 2) data.twoContacts = true;
      for (const touch of active) {
        const origin = this._tracking.origins.get(touch.id);
        if (!origin) this._tracking.origins.set(touch.id, [touch.x, touch.y]);
        else data.maxMovement = Math.max(data.maxMovement, distance([touch.x, touch.y], origin));
      }
      for (const id of this._tracking.origins.keys()) if (!ids.has(id)) { data.tap = true; this._tracking.origins.delete(id); }
      data.movement ||= data.maxMovement > 120;
      data.click ||= down(snapshot.buttons[17]);
      step.progress = ['tap', 'movement', 'twoContacts', 'click'].filter(key => data[key]).length / 4;
      if (step.progress === 1) this._finish('passed', 'Contact release, movement, two contacts, and touchpad click were observed.');
    } else if (step.id === 'motion') {
      for (const sensor of ['gyro', 'accel']) {
        const values = snapshot.motion[sensor].slice(0, 3);
        data[`${sensor}Variation`] = Math.max(data[`${sensor}Variation`], distance(values, this._tracking.base[sensor]));
        data[`${sensor}Range`] = values.map((value, i) => {
          this._tracking.min[sensor][i] = Math.min(this._tracking.min[sensor][i], value);
          this._tracking.max[sensor][i] = Math.max(this._tracking.max[sensor][i], value);
          return this._tracking.max[sensor][i] - this._tracking.min[sensor][i];
        });
      }
      step.progress = [...data.gyroRange.map(range => Math.min(1, range / 15)), ...data.accelRange.map(range => Math.min(1, range / 0.25))].reduce((sum, progress) => sum + progress, 0) / 6;
      if (data.gyroRange.every(range => range > 15) && data.accelRange.every(range => range > 0.25)) this._finish('passed', 'Changes on all three gyro axes and all three acceleration axes were observed; sensor calibration was not checked.');
    } else if (step.id === 'charging') {
      data.powerState = snapshot.battery.powerState;
      data.battery = clone(snapshot.battery);
      data.transport = snapshot.transport ?? null;
      const reason = {
        error: 'The controller reports a charging error. Check the USB power connection and reported battery status, then retest.',
        'not-charging': 'The controller reports not charging. Check the USB cable and power source, then retest.',
        discharging: 'The controller reports discharging. Connect USB power and retest.',
      }[data.powerState];
      this._finish(reason ? 'needs-check' : 'passed', `${reason || `The controller reports ${data.powerState}.`} This does not confirm charging current or battery health.`);
    }
    return this.getSummary();
  }

  advance(now = this._now) { return this.skip('Continued without completing this check.', now); }

  skip(reason = 'Skipped by the user.', now = this._now) {
    this._clock(now);
    if (this._state === 'running') this._finish('skipped', String(reason));
    return this.getSummary();
  }

  recordManual(id, status = 'passed', detail = '', now = this._now) {
    this._clock(now);
    if (this._state !== 'running' || this._steps[this._index].id !== id || !TERMINAL.has(status)) return this.getSummary();
    this._finish(status, String(detail) || (status === 'passed' ? 'Confirmed by the user.' : 'Recorded by the user.'));
    return this.getSummary();
  }

  cancel(reason = 'Stopped by the user.') {
    if (this._state === 'running') {
      Object.assign(this._steps[this._index], { status: 'skipped', detail: String(reason) });
      this._state = 'cancelled'; this._reason = String(reason); this._endedAt = this._now;
    }
    return this.getSummary();
  }

  getSummary() {
    return clone({
      state: this._state, deviceKey: this._key, source: this._source,
      reason: this._reason, startedAt: this._startedAt, endedAt: this._endedAt,
      stepIndex: this._index, steps: this._steps,
      activeStep: this._state === 'running' ? this._steps[this._index] : null,
      completedCount: this._steps.filter(step => TERMINAL.has(step.status)).length,
      total: this._steps.length,
    });
  }
}
