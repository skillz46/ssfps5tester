// USB report 2 uses a 47-byte payload without the report ID. Protocol sources: README.md.
// Transient outputs only; no feature, calibration, firmware, pairing or microphone-mute writes.
const PRODUCTS = new Set([0x0ce6, 0x0df2]);
const PLAYER_PATTERNS = [0, 0x04, 0x0a, 0x15, 0x1b, 0x1f];
const now = () => globalThis.performance?.now?.() ?? Date.now();
const integer = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;

export function buildAdaptiveTriggerReport(side = 'both', enabled = true) {
  if (!['left', 'right', 'both'].includes(side) || typeof enabled !== 'boolean') throw new TypeError('Choose left, right or both triggers.');
  const bytes = new Uint8Array(47);
  for (const [name, offset, flag] of [['right', 10, 0x04], ['left', 21, 0x08]]) {
    if (side !== 'both' && side !== name) continue;
    bytes[0] |= flag;
    bytes[offset] = enabled ? 0x21 : 0x05;
    if (!enabled) continue;
    // Moderate feedback (3 of 8) beginning at travel zone 4 of 10.
    let active = 0, strengths = 0;
    for (let zone = 4; zone < 10; zone++) {
      active |= 1 << zone;
      strengths |= 2 << (zone * 3); // feedback encodes strength minus one.
    }
    bytes[offset + 1] = active & 255;
    bytes[offset + 2] = active >>> 8;
    for (let i = 0; i < 4; i++) bytes[offset + 3 + i] = (strengths >>> (i * 8)) & 255;
  }
  return bytes;
}

export function buildLightReport({ color, player, mute, setup = false, brightness } = {}) {
  const bytes = new Uint8Array(47);
  if (color !== undefined) {
    if (!Array.isArray(color) || color.length !== 3 || !color.every(value => integer(value, 255))) throw new TypeError('Use three RGB bytes.');
    bytes[1] |= 0x04;
    bytes.set(color, 44);
  }
  if (player !== undefined) {
    if (!integer(player, 5)) throw new TypeError('Player pattern must be from zero to five.');
    bytes[1] |= 0x10;
    bytes[43] = PLAYER_PATTERNS[player] | 0x20; // instant update; no fade.
  }
  if (mute !== undefined) {
    if (!integer(mute, 2)) throw new TypeError('Mute indicator must be off, on or pulse.');
    bytes[1] |= 0x01;
    bytes[8] = mute;
  }
  if (setup) { bytes[38] |= 0x02; bytes[41] = 0x02; }
  if (brightness !== undefined) {
    if (!integer(brightness, 2)) throw new TypeError('Use a supported LED brightness.');
    bytes[38] |= 0x01; bytes[42] = brightness;
  }
  return bytes;
}

const hues = [
  ['Red', [96, 0, 0]], ['Orange', [96, 48, 0]], ['Yellow', [96, 96, 0]],
  ['Lime', [48, 96, 0]], ['Green', [0, 96, 0]], ['Mint', [0, 96, 48]],
  ['Cyan', [0, 96, 96]], ['Azure', [0, 48, 96]], ['Blue', [0, 0, 96]],
  ['Violet', [48, 0, 96]], ['Magenta', [96, 0, 96]], ['Rose', [96, 0, 48]],
  ['White', [64, 64, 64]], ['Light bar off', [0, 0, 0]],
];
export const LIGHT_SEQUENCE = Object.freeze([
  ...hues.map(([label, color]) => Object.freeze({ phase: 'color', label, color: Object.freeze(color) })),
  ...[1, 2, 3, 4, 5].map(player => Object.freeze({ phase: 'player', label: `Player ${player} indicator`, player })),
  ...['Mute indicator off', 'Mute indicator on', 'Mute indicator pulse'].map((label, mute) => Object.freeze({ phase: 'mute', label, mute })),
]);

function descriptorSupported(device) {
  const scan = collections => (collections || []).some(collection =>
    (collection.outputReports || []).some(report => report.reportId === 2 && report.items?.length && report.items.every(item => integer(item.reportSize, 65535) && item.reportSize > 0 && integer(item.reportCount, 65535) && item.reportCount > 0) && report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0) === 47 * 8) || scan(collection.children));
  return scan(device.collections);
}

export class ControllerEffects {
  constructor({ getRecord, getState, onStatus = () => {}, onProgress = () => {}, clock = now, triggerDurationMs = 2200, lightStepMs = 350, cleanupTimeoutMs = 1000, watchdogMs = 100 } = {}) {
    this.getRecord = getRecord || (() => null); this.getState = getState || (() => null);
    this.onStatus = onStatus; this.onProgress = onProgress; this.clock = clock;
    this.timing = { trigger: Math.max(10, Math.min(3000, triggerDurationMs)), light: Math.max(1, Math.min(500, lightStepMs)), cleanup: Math.max(10, Math.min(1500, cleanupTimeoutMs)), watch: Math.max(5, Math.min(250, watchdogMs)) };
    this.runs = { adaptiveTriggers: null, lights: null };
    this.generations = { adaptiveTriggers: 0, lights: 0 }; this.closed = false;
    this.hidden = () => { if (globalThis.document?.hidden) void this.stopAll(); };
    this.blur = () => { void this.stopAll(); };
    globalThis.addEventListener?.('blur', this.blur);
    globalThis.addEventListener?.('pagehide', this.blur);
    globalThis.document?.addEventListener?.('visibilitychange', this.hidden);
  }

  supported(record = this.getRecord(), state = this.getState()) {
    const device = record?.device, age = this.clock() - record?.timestamp;
    return !this.closed && device?.opened === true && device.vendorId === 0x054c && PRODUCTS.has(device.productId) && typeof device.sendReport === 'function' && record.profile?.id === 2 && record.profile?.length === 47 && record.profile?.ds4 === false && descriptorSupported(device) && record.parsed?.transport === 'usb' && state?.source === 'hid' && state.transport === 'usb' && state.key === record.key && Number.isFinite(age) && age >= 0 && age <= 1000;
  }

  capabilities() {
    const supported = this.supported();
    return { adaptiveTriggers: supported, lights: supported };
  }

  progress(run, detail) {
    try { this.onProgress({ kind: run.kind, running: !run.cancelled, ...detail }); } catch {}
  }

  valid(run) {
    return this.runs[run.kind] === run && !run.cancelled && this.generations[run.kind] === run.generation && !globalThis.document?.hidden && this.getRecord() === run.record && this.supported(run.record, this.getState());
  }

  async write(run, bytes) {
    const record = run.record;
    const work = Promise.resolve(record.outputTail).catch(() => {}).then(async () => {
      if (!this.valid(run)) return false;
      await record.device.sendReport(2, bytes);
      return this.valid(run);
    });
    record.outputTail = work;
    return Promise.race([work, run.stopped]);
  }

  wait(run, ms) {
    if (!this.valid(run)) return Promise.resolve(false);
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); run.waiters.delete(finish); resolve(value); };
      const timer = setTimeout(() => finish(this.valid(run)), ms);
      run.waiters.add(finish);
    });
  }

  async cleanup(run) {
    if (run.cleanup) return run.cleanup;
    const record = run.record;
    const bytes = run.kind === 'adaptiveTriggers' ? buildAdaptiveTriggerReport('both', false) : buildLightReport({ color: [0, 0, 0], player: 0, mute: 0, brightness: 0 });
    const work = Promise.resolve(record.outputTail).catch(() => {}).then(async () => {
      if (!record.device.opened) return false;
      await record.device.sendReport(2, bytes);
      return true;
    });
    record.outputTail = work;
    // A stalled WebHID transfer cannot be forcibly cancelled. Keep the neutral
    // packet queued, but allow the UI to stop rather than waiting indefinitely.
    run.cleanup = new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), this.timing.cleanup);
      work.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(false); });
    });
    return run.cleanup;
  }

  async stop(kind) {
    this.generations[kind]++;
    const run = this.runs[kind];
    this.runs[kind] = null;
    if (!run) return true;
    run.cancelled = true;
    clearInterval(run.watchdog); clearTimeout(run.deadline);
    for (const finish of [...run.waiters]) finish(false);
    run.resolveStop(false);
    this.progress(run, { phase: 'stopping', label: 'Stopping controller output…', running: false });
    const okay = await this.cleanup(run);
    if (okay && !this.runs[kind]) this.progress(run, { phase: 'stopped', label: kind === 'lights' ? 'Light-off command sent' : 'Trigger release command sent', running: false });
    if (!okay && run.record.device.opened) this.onStatus('The test stopped, but its neutral output could not be confirmed. Reconnect the controller before retesting.', 'error');
    return okay;
  }

  stopAdaptiveTriggers() { return this.stop('adaptiveTriggers'); }
  stopLights() { return this.stop('lights'); }
  async stopAll() { const result = await Promise.all([this.stopAdaptiveTriggers(), this.stopLights()]); return result.every(Boolean); }

  async start(kind) {
    const generation = this.generations[kind] + 1;
    const stopped = await this.stop(kind);
    if (this.generations[kind] !== generation || !stopped || !this.supported() || globalThis.document?.hidden) return null;
    const run = { kind, generation, record: this.getRecord(), waiters: new Set(), cancelled: false };
    run.stopped = new Promise(resolve => { run.resolveStop = resolve; });
    this.runs[kind] = run;
    run.watchdog = setInterval(() => { if (!this.valid(run)) void this.stop(kind); }, this.timing.watch);
    const duration = kind === 'lights' ? LIGHT_SEQUENCE.length * this.timing.light + 1500 : this.timing.trigger + 1000;
    run.deadline = setTimeout(() => { if (this.runs[kind] === run) void this.stop(kind); }, duration);
    return run;
  }

  async finish(run, okay) {
    if (this.runs[run.kind] !== run) return false;
    const cleaned = await this.stop(run.kind);
    const current = !this.runs[run.kind] && this.generations[run.kind] === run.generation + 1;
    if (okay && cleaned && current) this.progress(run, { phase: 'complete', label: 'Commands completed. Confirm the physical response.', running: false });
    return okay && cleaned && current;
  }

  async testAdaptiveTriggers(side = 'both') {
    if (!['left', 'right', 'both'].includes(side)) return false;
    const run = await this.start('adaptiveTriggers');
    if (!run) { this.onStatus('Adaptive trigger testing needs a live DualSense or DualSense Edge USB connection.', 'info'); return false; }
    let okay = false;
    try {
      okay = await this.write(run, buildAdaptiveTriggerReport(side, true));
      if (okay) { this.progress(run, { phase: 'resistance', label: `${side === 'both' ? 'Both' : side === 'left' ? 'Left' : 'Right'} trigger resistance · squeeze gently`, side }); okay = await this.wait(run, this.timing.trigger); }
    } catch { okay = false; this.onStatus('The controller could not run the adaptive trigger test.', 'error'); }
    return this.finish(run, okay);
  }

  async cycleLights() {
    const run = await this.start('lights');
    if (!run) { this.onStatus('Light testing needs a live DualSense or DualSense Edge USB connection.', 'info'); return false; }
    let okay = false;
    try {
      okay = await this.write(run, buildLightReport({ setup: true, brightness: 1, color: [0, 0, 0], player: 0, mute: 0 }));
      for (let index = 0; okay && index < LIGHT_SEQUENCE.length; index++) {
        const step = LIGHT_SEQUENCE[index];
        okay = await this.write(run, buildLightReport(step));
        if (okay) { this.progress(run, { ...step, index: index + 1, total: LIGHT_SEQUENCE.length }); okay = await this.wait(run, this.timing.light); }
      }
    } catch { okay = false; this.onStatus('The controller could not complete the light cycle.', 'error'); }
    return this.finish(run, okay);
  }

  async dispose() {
    this.closed = true;
    globalThis.removeEventListener?.('blur', this.blur);
    globalThis.removeEventListener?.('pagehide', this.blur);
    globalThis.document?.removeEventListener?.('visibilitychange', this.hidden);
    return this.stopAll();
  }
}
