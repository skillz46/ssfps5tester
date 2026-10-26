import { ControllerEffects } from './controller-effects.js';
import { ControllerInfoReader } from './controller-info.js';
// Sony USB layouts adapted from dualshock-tools (MIT, © 2024 the_al); see third-party/dualshock-tools-LICENSE.txt.
// Identity requests select metadata only. Calibration and firmware writes are not implemented.
const SONY = new Map([
  [0x05c4, { name: 'DualShock 4', ds4: true, count: 18 }],
  [0x09cc, { name: 'DualShock 4', ds4: true, count: 18 }],
  [0x0ce6, { name: 'DualSense', ds4: false, count: 19 }],
  [0x0df2, { name: 'DualSense Edge', ds4: false, count: 23 }],
]);
const clamp = (v, low = 0, high = 1) => Math.min(high, Math.max(low, Number.isFinite(v) ? v : 0));
const button = (value = 0, pressed = value > 0, touched = pressed) => ({ value: clamp(value), pressed: !!pressed, touched: !!touched });
const empty = () => ({ battery: null, touches: [], motion: null, speakerTone: false, adaptiveTriggers: false, lights: false });
const gamepadKey = p => `gamepad:${p.index}:${p.id}`;
const time = () => globalThis.performance?.now?.() ?? Date.now();

function sonyBattery(ds4, statusByte) {
  const charge = statusByte & 15;
  // Capacity uses ten-percent buckets. Reserved capacity codes remain unknown;
  // in particular an error must never become a false 0% battery reading.
  const result = { level: null, charging: false, powerState: 'unknown', externalPower: null };
  const capacity = charge <= 10 ? clamp((charge * 10 + 5) / 100) : null;
  if (ds4) {
    result.externalPower = !!(statusByte & 0x10);
    if (!result.externalPower) {
      if (capacity !== null) Object.assign(result, { level: capacity, powerState: 'discharging' });
    } else if (capacity !== null) {
      Object.assign(result, { level: capacity, charging: true, powerState: 'charging' });
    } else if (charge === 11) {
      Object.assign(result, { level: 1, powerState: 'full' });
    } else if (charge === 14) {
      result.powerState = 'not-charging';
    } else if (charge === 15) {
      result.powerState = 'error';
    }
    return result;
  }
  const status = statusByte >> 4;
  // Linux hid-playstation defines 0xf as a charging error, not a flat battery.
  // https://github.com/torvalds/linux/blob/master/drivers/hid/hid-playstation.c
  if (status === 0) result.externalPower = false;
  if (status === 1 || status === 2) result.externalPower = true;
  if (status === 10 || status === 11) result.powerState = 'not-charging';
  else if (status === 15) result.powerState = 'error';
  else if (capacity !== null && status === 0) Object.assign(result, { level: capacity, powerState: 'discharging' });
  else if (capacity !== null && status === 1) Object.assign(result, { level: capacity, charging: true, powerState: 'charging' });
  else if (capacity !== null && status === 2) Object.assign(result, { level: 1, powerState: 'full' });
  return result;
}

function gamepadActuator(pad) {
  const actuator = pad?.vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== 'function') return null;
  if (actuator.effects && !Array.from(actuator.effects).includes('dual-rumble')) return null;
  if (actuator.type && actuator.type !== 'dual-rumble' && !actuator.effects?.includes?.('dual-rumble')) return null;
  return actuator;
}

/** Browser-provided axes retain their original order on nonstandard mappings. */
export function normalizeGamepad(pad) {
  if (!pad || pad.connected === false) return null;
  const rawAxes = Array.from(pad.axes ?? [], v => Number.isFinite(v) ? clamp(v, -1, 1) : null);
  const standard = pad.mapping === 'standard';
  return {
    key: gamepadKey(pad), name: pad.id || 'Controller', source: 'gamepad',
    mapping: standard ? 'standard' : 'raw',
    axes: standard ? Array.from({ length: 4 }, (_, i) => rawAxes[i] ?? null) : [],
    rawAxes,
    buttons: Array.from(pad.buttons ?? [], b => typeof b === 'number' ? button(b) : button(b?.value, b?.pressed, b?.touched)),
    timestamp: Number.isFinite(pad.timestamp) ? pad.timestamp : 0,
    sampleId: Number.isFinite(pad.timestamp) ? pad.timestamp : 0,
    haptics: !!gamepadActuator(pad), ...empty(),
  };
}

/** USB report 1 only. Bluetooth and short reports are deliberately rejected. */
export function parseSonyUsbReport(productId, reportId, data) {
  const model = SONY.get(productId);
  if (!model || reportId !== 1 || !(data instanceof DataView) || data.byteLength !== 63) return null;
  const ds4 = model.ds4;
  const b = i => data.getUint8(i);
  const face = b(ds4 ? 4 : 7), shoulder = b(ds4 ? 5 : 8), special = b(ds4 ? 6 : 9);
  const hat = face & 15;
  const bit = (byte, mask) => button(byte & mask ? 1 : 0);
  const buttons = [
    bit(face, 0x20), bit(face, 0x40), bit(face, 0x10), bit(face, 0x80),
    bit(shoulder, 1), bit(shoulder, 2), button(b(ds4 ? 7 : 4) / 255), button(b(ds4 ? 8 : 5) / 255),
    bit(shoulder, 0x10), bit(shoulder, 0x20), bit(shoulder, 0x40), bit(shoulder, 0x80),
    button([0, 1, 7].includes(hat) ? 1 : 0), button([3, 4, 5].includes(hat) ? 1 : 0),
    button([5, 6, 7].includes(hat) ? 1 : 0), button([1, 2, 3].includes(hat) ? 1 : 0),
    bit(special, 1), bit(special, 2),
  ];
  if (!ds4) buttons.push(bit(special, 4));
  if (productId === 0x0df2) for (const mask of [0x10, 0x20, 0x40, 0x80]) buttons.push(bit(special, mask));
  const touchOffset = ds4 ? 34 : 32;
  const touches = Array.from({ length: 2 }, (_, i) => {
    const off = touchOffset + i * 4;
    return { active: !(b(off) & 0x80), id: b(off) & 0x7f, x: ((b(off + 2) & 15) << 8) | b(off + 1), y: (b(off + 3) << 4) | (b(off + 2) >> 4) };
  });
  const imuOffset = ds4 ? 12 : 15;
  const gyro = [0, 2, 4].map(i => data.getInt16(imuOffset + i, true) / 14.31);
  const accel = [6, 8, 10].map(i => data.getInt16(imuOffset + i, true) / 8192);
  const battery = sonyBattery(ds4, b(ds4 ? 29 : 52));
  const axes = [0, 1, 2, 3].map(i => (b(i) - 127.5) / 127.5);
  return { axes, rawAxes: [...axes], buttons, battery, touches, motion: { gyro, accel }, transport: 'usb', model: model.name };
}

function hidOutputProfile(device) {
  const model = SONY.get(device.productId);
  if (!model) return null;
  const id = model.ds4 ? 5 : 2, length = model.ds4 ? 31 : 47;
  const scan = collections => {
    for (const collection of collections ?? []) {
      for (const report of collection.outputReports ?? []) {
        if (report.reportId !== id) continue;
        const items = report.items;
        if (!items?.length || !items.every(item => Number.isInteger(item.reportSize) && item.reportSize > 0 && Number.isInteger(item.reportCount) && item.reportCount > 0)) continue;
        const bits = items.reduce((total, item) => total + item.reportSize * item.reportCount, 0);
        if (bits === length * 8) return { id, length, ds4: model.ds4 };
      }
      const nested = scan(collection.children);
      if (nested) return nested;
    }
    return null;
  };
  return scan(device.collections);
}

function speakerFeatureLength(device) {
  if (![0x0ce6, 0x0df2].includes(device.productId) || typeof device.sendFeatureReport !== 'function') return null;
  const scan = collections => {
    for (const collection of collections ?? []) {
      for (const report of collection.featureReports ?? []) {
        if (report.reportId !== 0x80 || !report.items?.length) continue;
        if (!report.items.every(item => Number.isInteger(item.reportSize) && item.reportSize > 0 && Number.isInteger(item.reportCount) && item.reportCount > 0)) continue;
        const bits = report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0);
        if (bits % 8 === 0 && bits >= 40 && bits <= 512) return bits / 8;
      }
      const child = scan(collection.children);
      if (child) return child;
    }
    return null;
  };
  return scan(device.collections);
}

export class ControllerHub extends EventTarget {
  constructor() {
    super();
    this.devices = [];
    this.activeKey = null;
    this._gamepads = new Map();
    this._hid = new Map();
    this._nextHid = 0;
    this._running = false;
    this._sample = 0;
    this._rumbleGeneration = 0;
    this._speakerGeneration = 0;
    this._effects = new ControllerEffects({
      getRecord: () => this._hid.get(this.activeKey),
      getState: () => { const record = this._hid.get(this.activeKey); return record ? { key: record.key, source: 'hid', transport: record.parsed?.transport } : null; },
      onStatus: (message, kind = 'info') => this._status(kind, message),
      onProgress: detail => this.dispatchEvent(new CustomEvent('effectsprogress', { detail })),
    });
    this._infoReader = new ControllerInfoReader({
      getRecord: () => this._hid.get(this.activeKey),
      getState: () => {
        const record = this._hid.get(this.activeKey), device = this.devices.find(device => device.key === this.activeKey);
        return { key: this.activeKey, source: device?.source, name: device?.name, model: record?.parsed?.model, transport: record?.parsed?.transport };
      },
      onChange: () => this.dispatchEvent(new Event('controllerinfochange')),
    });
    this._onBlur = () => { void this.stopRumble(); void this.stopSpeakerTone(); void this.stopControllerEffects(); };
    this._onVisibility = () => { if (globalThis.document?.hidden) this._onBlur(); };
    this._onHidDisconnect = event => { void this._removeHid(event.device); };
    this._onGamepadChange = () => this._pollGamepads();
  }

  _status(kind, message) { this.dispatchEvent(new CustomEvent('status', { detail: { kind, message } })); }

  start() {
    if (this._running) return;
    this._running = true;
    globalThis.addEventListener?.('blur', this._onBlur);
    globalThis.addEventListener?.('pagehide', this._onBlur);
    globalThis.addEventListener?.('gamepadconnected', this._onGamepadChange);
    globalThis.addEventListener?.('gamepaddisconnected', this._onGamepadChange);
    globalThis.document?.addEventListener('visibilitychange', this._onVisibility);
    globalThis.navigator?.hid?.addEventListener?.('disconnect', this._onHidDisconnect);
    const frame = () => {
      if (!this._running) return;
      this._pollGamepads();
      this._raf = globalThis.requestAnimationFrame?.(frame);
    };
    frame();
  }

  _pollGamepads() {
    try {
      const pads = globalThis.navigator?.getGamepads?.() ?? [];
      const next = new Map();
      for (const pad of pads) if (pad?.connected !== false && pad) next.set(gamepadKey(pad), pad);
      if (this._rumbleTarget?.source === 'gamepad' && !next.has(this._rumbleTarget.key)) void this.stopRumble();
      this._gamepads = next;
      this._refresh();
    } catch (error) {
      if (!this._pollError) this._status('error', `Controller access is unavailable: ${error.message}`);
      this._pollError = true;
    }
  }

  _refresh() {
    const previous = JSON.stringify(this.devices), previousActive = this.activeKey;
    const devices = [...this._gamepads].map(([key, p]) => ({ key, name: p.id || 'Controller', source: 'gamepad', mapping: p.mapping === 'standard' ? 'standard' : 'raw', buttonCount: p.buttons?.length ?? 0 }));
    for (const [key, record] of this._hid) devices.push({ key, name: record.name, source: 'hid', mapping: 'standard', buttonCount: SONY.get(record.device.productId).count });
    this.devices = devices;
    if (!devices.some(d => d.key === this.activeKey)) this.activeKey = devices[0]?.key ?? null;
    if (previousActive !== this.activeKey) this._infoReader.invalidate();
    if (previous !== JSON.stringify(devices) || previousActive !== this.activeKey) this.dispatchEvent(new Event('deviceschange'));
  }

  select(key) {
    if (!this.devices.some(device => device.key === key)) return false;
    const changed = key !== this.activeKey;
    if (changed) { void this.stopRumble(); void this.stopSpeakerTone(); void this.stopControllerEffects(); }
    this.activeKey = key;
    if (changed) this._infoReader.invalidate();
    this._refresh();
    this.dispatchEvent(new Event('deviceschange'));
    return true;
  }

  async connectPlayStation() {
    if (!globalThis.navigator?.hid) {
      this._status('error', 'Detailed PlayStation testing needs Chrome or Edge on a secure page.');
      return null;
    }
    try {
      // Keep the chooser in the original user gesture; no preceding asynchronous work.
      const chosen = await navigator.hid.requestDevice({ filters: [...SONY.keys()].map(productId => ({ vendorId: 0x054c, productId })) });
      const device = chosen.find(d => d.vendorId === 0x054c && SONY.has(d.productId));
      if (!device) return null;
      const existing = [...this._hid.values()].find(r => r.device === device);
      if (existing) { this.select(existing.key); return existing.key; }
      if (!device.opened) await device.open();
      const key = `hid:${++this._nextHid}`;
      const record = { key, device, name: `${SONY.get(device.productId).name} · detailed USB`, parsed: null, profile: hidOutputProfile(device), speakerFeatureLength: speakerFeatureLength(device), sampleId: 0, outputTail: Promise.resolve(), outputFailed: false };
      record.input = event => {
        const parsed = parseSonyUsbReport(device.productId, event.reportId, event.data);
        if (!parsed) {
          record.parsed = null;
          if (this._rumbleTarget?.key === key) void this.stopRumble();
          if (this._speakerTarget?.key === key) void this.stopSpeakerTone();
          if (this.activeKey === key) void this.stopControllerEffects();
          if (!record.warned) this._status('info', 'Detailed PlayStation mode needs a USB cable. Bluetooth controllers can use the standard tester.');
          record.warned = true;
          return;
        }
        record.warned = false;
        record.parsed = parsed;
        record.timestamp = time();
        record.sampleId += 1;
      };
      device.addEventListener('inputreport', record.input);
      this._hid.set(key, record);
      this._refresh();
      this.select(key);
      this._status('info', `${SONY.get(device.productId).name} opened. Detailed input requires USB; battery readings are approximate.`);
      return key;
    } catch (error) {
      this._status(error.name === 'NotFoundError' ? 'info' : 'error', error.name === 'NotFoundError' ? 'No PlayStation controller selected.' : `Could not open controller: ${error.message}`);
      return null;
    }
  }

  snapshot(now = time()) {
    const pad = this._gamepads.get(this.activeKey);
    if (pad) return { ...normalizeGamepad(pad), timestamp: pad.timestamp || now, sampleId: ++this._sample };
    const record = this._hid.get(this.activeKey);
    if (!record?.parsed || !record.device.opened || now - record.timestamp > 1000) {
      if (record && this._rumbleTarget?.key === record.key) void this.stopRumble();
      if (record && this._speakerTarget?.key === record.key) void this.stopSpeakerTone();
      if (record) void this.stopControllerEffects();
      return null;
    }
    return { ...record.parsed, key: record.key, name: record.name, source: 'hid', mapping: 'standard', timestamp: record.timestamp, sampleId: record.sampleId, haptics: !!record.profile && !record.outputFailed, speakerTone: !!record.profile && !record.profile.ds4 && !!record.speakerFeatureLength && !record.speakerFailed, ...this._effects.capabilities() };
  }

  testAdaptiveTriggers(side = 'both') { return this._effects.testAdaptiveTriggers(side); }
  cycleLights() { return this._effects.cycleLights(); }
  stopAdaptiveTriggers() { return this._effects.stopAdaptiveTriggers(); }
  stopLights() { return this._effects.stopLights(); }
  stopControllerEffects() { return this._effects.stopAll(); }
  readControllerInfo() { return this._infoReader.read(); }
  getControllerInfo() { return this._infoReader.get(); }

  _sendHidRumble(record, strong, weak) {
    const profile = record.profile;
    if (!profile) return Promise.resolve();
    const payload = new Uint8Array(profile.length);
    payload[0] = profile.ds4 ? 1 : 3;
    payload[profile.ds4 ? 3 : 2] = Math.round(clamp(weak) * 255);
    payload[profile.ds4 ? 4 : 3] = Math.round(clamp(strong) * 255);
    const work = record.outputTail.catch(() => {}).then(() => {
      if (!record.device.opened) return;
      return record.device.sendReport(profile.id, payload);
    });
    record.outputTail = work;
    return work;
  }

  async rumble(mode = 'both') {
    if (!['both', 'left', 'right', 'strong', 'weak'].includes(mode)) return false;
    const key = this.activeKey, state = this.snapshot();
    if (!state?.haptics) {
      this._status('info', 'Vibration is unavailable for this controller or connection.');
      return false;
    }
    const generation = this._rumbleGeneration + 1;
    await this.stopRumble();
    if (this.activeKey !== key || this._rumbleGeneration !== generation || globalThis.document?.hidden) return false;
    const strong = ['both', 'left', 'strong'].includes(mode) ? 0.45 : 0;
    const weak = ['both', 'right', 'weak'].includes(mode) ? 0.45 : 0;
    const record = this._hid.get(key), pad = this._gamepads.get(key), actuator = gamepadActuator(pad);
    const target = { key, source: state.source, record, actuator };
    this._rumbleTarget = target;
    // Arm the stop even if a hardware write is slow.
    this._rumbleTimer = setTimeout(() => { if (this._rumbleTarget === target) void this.stopRumble(); }, record ? 350 : 400);
    try {
      if (record) await this._sendHidRumble(record, strong, weak);
      else if (actuator) {
        const result = await actuator.playEffect('dual-rumble', { startDelay: 0, duration: 350, strongMagnitude: strong, weakMagnitude: weak });
        if (result !== 'complete') throw new Error(`Controller reported ${result ?? 'no result'}`);
      }
      return true;
    } catch (error) {
      if (record) record.outputFailed = true;
      this._status('error', `Vibration could not run: ${error.message}`);
      if (this._rumbleTarget === target) await this.stopRumble();
      return false;
    }
  }

  async stopRumble() {
    this._rumbleGeneration += 1;
    clearTimeout(this._rumbleTimer);
    this._rumbleTimer = null;
    const target = this._rumbleTarget;
    this._rumbleTarget = null;
    if (!target) return;
    try {
      if (target.record) await this._sendHidRumble(target.record, 0, 0);
      else if (target.actuator?.reset) await target.actuator.reset();
      else if (target.actuator) await target.actuator.playEffect('dual-rumble', { startDelay: 0, duration: 1, strongMagnitude: 0, weakMagnitude: 0 });
    } catch (error) {
      this._status('error', `Could not stop vibration: ${error.message}`);
    }
  }

  _audioFeature(record, prefix) {
    const bytes = new Uint8Array(record.speakerFeatureLength);
    bytes.set(prefix);
    return record.device.sendFeatureReport(0x80, bytes);
  }

  _audioVolume(record, volume) {
    const bytes = new Uint8Array(47);
    bytes[0] = 0xa0; // Speaker volume and audio control only.
    bytes[5] = volume;
    return record.device.sendReport(2, bytes);
  }

  async playSpeakerTone() {
    const key = this.activeKey, state = this.snapshot();
    if (!state?.speakerTone) {
      this._status('info', 'The built-in speaker tone needs a compatible DualSense USB connection.');
      return false;
    }
    const generation = this._speakerGeneration + 1;
    await this.stopSpeakerTone();
    if (this._speakerGeneration !== generation || this.activeKey !== key || globalThis.document?.hidden) return false;
    const record = this._hid.get(key), target = { key, record, generation };
    this._speakerTarget = target;
    const valid = () => this._speakerTarget === target && this._speakerGeneration === generation && record.device.opened && !!record.parsed && time() - record.timestamp <= 1000 && !globalThis.document?.hidden;
    this._speakerTimer = setTimeout(() => { if (this._speakerTarget === target) void this.stopSpeakerTone(); }, 700);
    const work = record.outputTail.catch(() => {}).then(async () => {
      if (!valid()) return false;
      await this._audioVolume(record, 55);
      if (!valid()) return false;
      await this._audioFeature(record, [6, 4, 0, 0, 8]);
      if (!valid()) return false;
      await this._audioFeature(record, [6, 2, 1, 1, 0]);
      return valid();
    });
    record.outputTail = work;
    try { return await work; }
    catch (error) {
      record.speakerFailed = true;
      this._status('error', `Controller speaker tone failed: ${error.message}`);
      if (this._speakerTarget === target) await this.stopSpeakerTone();
      return false;
    }
  }

  async stopSpeakerTone() {
    this._speakerGeneration += 1;
    clearTimeout(this._speakerTimer);
    this._speakerTimer = null;
    const target = this._speakerTarget;
    this._speakerTarget = null;
    if (!target) return;
    const record = target.record;
    const work = record.outputTail.catch(() => {}).then(async () => {
      if (!record.device.opened) return;
      // Always try the mute output, even when the diagnostic stop is rejected.
      try { await this._audioFeature(record, [6, 2, 0, 1, 0]); }
      finally { await this._audioVolume(record, 0); }
    });
    record.outputTail = work;
    try { await work; }
    catch (error) { this._status('error', `Could not stop controller speaker: ${error.message}`); }
  }

  async _removeHid(device) {
    const record = [...this._hid.values()].find(r => r.device === device);
    if (!record) return;
    if (this.activeKey === record.key) this._infoReader.invalidate();
    if (this.activeKey === record.key) await this.stopControllerEffects();
    if (this._rumbleTarget?.key === record.key) await this.stopRumble();
    if (this._speakerTarget?.key === record.key) await this.stopSpeakerTone();
    device.removeEventListener('inputreport', record.input);
    this._hid.delete(record.key);
    this._refresh();
  }

  async dispose() {
    this._infoReader.dispose();
    this._running = false;
    globalThis.cancelAnimationFrame?.(this._raf);
    globalThis.removeEventListener?.('blur', this._onBlur);
    globalThis.removeEventListener?.('pagehide', this._onBlur);
    globalThis.removeEventListener?.('gamepadconnected', this._onGamepadChange);
    globalThis.removeEventListener?.('gamepaddisconnected', this._onGamepadChange);
    globalThis.document?.removeEventListener('visibilitychange', this._onVisibility);
    globalThis.navigator?.hid?.removeEventListener?.('disconnect', this._onHidDisconnect);
    await this.stopRumble();
    await this.stopSpeakerTone();
    await this._effects.dispose();
    for (const record of this._hid.values()) {
      record.device.removeEventListener('inputreport', record.input);
      try { if (record.device.opened) await record.device.close(); } catch { /* Already disconnected. */ }
    }
    this._hid.clear();
    this._gamepads.clear();
    this._refresh();
  }
}
