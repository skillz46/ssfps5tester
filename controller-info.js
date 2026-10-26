// Metadata layouts adapted from dualshock-tools (MIT, © 2024 the_al); see third-party/dualshock-tools-LICENSE.txt.
// Sources: https://github.com/dualshock-tools/dualshock-tools.github.io and Linux drivers/hid/hid-playstation.c.
const MODELS = new Map([[0x05c4, 'DualShock 4'], [0x09cc, 'DualShock 4'], [0x0ce6, 'DualSense'], [0x0df2, 'DualSense Edge']]);
const SOFTWARE = [['fwBuildDate', 'FW Build Date'], ['fwType', 'FW Type'], ['fwSeries', 'FW Series'], ['fwVersion', 'FW Version'], ['fwUpdate', 'FW Update'], ['fwUpdateInfo', 'FW Update Info'], ['sblVersion', 'SBL FW Version'], ['venomVersion', 'Venom FW Version'], ['spiderVersion', 'Spider FW Version']];
const HARDWARE = [['model', 'Model'], ['serialNumber', 'Serial Number'], ['mcuId', 'MCU Unique ID'], ['pcbaId', 'PCBA ID'], ['batteryBarcode', 'Battery Barcode'], ['vcmLeftBarcode', 'VCM Left Barcode'], ['vcmRightBarcode', 'VCM Right Barcode'], ['color', 'Color'], ['boardModel', 'Board Model'], ['hwModel', 'HW Model'], ['deviceType', 'Device Type'], ['bluetoothAddress', 'Bluetooth Address'], ['vendorId', 'Vendor ID'], ['productId', 'Product ID']];
const MANUFACTURING = Object.freeze([
  Object.freeze({ id: 'serialNumber', selector: 19, length: 17 }),
  Object.freeze({ id: 'mcuId', selector: 9, length: 9, hex: true }),
  Object.freeze({ id: 'pcbaId', selector: 17, length: 14, reverse: true }),
  Object.freeze({ id: 'batteryBarcode', selector: 24, length: 23 }),
  Object.freeze({ id: 'vcmLeftBarcode', selector: 26, length: 16 }),
  Object.freeze({ id: 'vcmRightBarcode', selector: 28, length: 16 }),
]);
const COLORS = new Map([['00', 'White'], ['01', 'Midnight Black'], ['02', 'Cosmic Red'], ['03', 'Nova Pink'], ['04', 'Galactic Purple'], ['05', 'Starlight Blue'], ['06', 'Grey Camouflage'], ['07', 'Volcanic Red'], ['08', 'Sterling Silver'], ['09', 'Cobalt Blue'], ['10', 'Chroma Teal'], ['11', 'Chroma Indigo'], ['12', 'Chroma Pearl'], ['13', 'HyperPop Techno Red'], ['14', 'HyperPop Remix Green'], ['15', 'HyperPop Rhythm Blue'], ['30', '30th Anniversary'], ['Z1', 'God of War Ragnarok'], ['Z2', 'Spider-Man 2'], ['Z3', 'Astro Bot'], ['Z4', 'Fortnite'], ['Z6', 'The Last of Us'], ['ZA', 'God of War 20th Anniversary'], ['ZB', 'Icon Blue Limited Edition'], ['ZC', 'Ghost of Yōtei Limited Edition'], ['ZD', 'Marathon Limited Edition'], ['ZE', 'Genshin Impact Limited Edition'], ['ZF', '007 First Light Limited Edition']]);
const DS5_BOARDS = new Map([[3, 'BDM-010'], [4, 'BDM-020'], [5, 'BDM-030'], [6, 'BDM-040'], [7, 'BDM-050'], [8, 'BDM-050'], [9, 'BDM-060R'], [0x11, 'BDM-060M'], [0x13, 'BDM-060X']]);
const hex = (value, size = 8) => `0x${value.toString(16).toUpperCase().padStart(size, '0')}`;
const clock = () => globalThis.performance?.now?.() ?? Date.now();
const rows = template => template.map(([id, label]) => ({ id, label, value: null }));
const copy = info => ({ ...info, software: info.software.map(field => ({ ...field })), hardware: info.hardware.map(field => ({ ...field })) });
const set = (info, id, value, source, note) => {
  const field = [...info.software, ...info.hardware].find(field => field.id === id);
  if (field) Object.assign(field, { value, ...(source ? { source } : {}), ...(note ? { note } : {}) });
};
const cancelled = () => Object.assign(new Error('Controller selection changed.'), { name: 'AbortError' });

export function featureReportLength(device, id) {
  const lengths = [];
  const scan = collections => {
    for (const collection of collections || []) {
      for (const report of collection.featureReports || []) {
        if (report.reportId !== id) continue;
        if (!report.items?.length || !report.items.every(item => Number.isInteger(item.reportSize) && item.reportSize > 0 && item.reportSize <= 65535 && Number.isInteger(item.reportCount) && item.reportCount > 0 && item.reportCount <= 65535)) return false;
        const bits = report.items.reduce((sum, item) => sum + item.reportSize * item.reportCount, 0);
        if (bits % 8 || bits > 512 * 8) return false;
        lengths.push(bits / 8);
      }
      if (!scan(collection.children)) return false;
    }
    return true;
  };
  return scan(device?.collections) && lengths.length && lengths.every(length => length === lengths[0]) ? lengths[0] : null;
}

function validReport(view, id, length) {
  return view instanceof DataView && view.byteLength === length && view.getUint8(0) === id;
}

function ascii(view, start, length) {
  const bytes = Array.from({ length }, (_, i) => view.getUint8(start + i));
  const end = bytes.indexOf(0);
  if (end !== -1 && bytes.slice(end).some(byte => byte !== 0 && byte !== 32)) return null;
  const value = bytes.slice(0, end === -1 ? bytes.length : end);
  return value.every(byte => byte >= 32 && byte <= 126) ? String.fromCharCode(...value).trim() || null : null;
}

export function inferBoardModel(productId, hardwareVersion) {
  if (productId === 0x0ce6) return DS5_BOARDS.get((hardwareVersion >>> 8) & 255) || null;
  if (![0x05c4, 0x09cc].includes(productId)) return null;
  const revision = hardwareVersion >>> 8;
  if (revision === 0x31) return 'JDM-001';
  if (revision === 0x43) return 'JDM-011';
  if (revision === 0x54) return 'JDM-030';
  if (revision >= 0x64 && revision <= 0x74) return 'JDM-040';
  if ((revision > 0x80 && revision < 0x84) || revision === 0x93) return 'JDM-020';
  if ([0xa4, 0x90, 0xa0].includes(revision)) return 'JDM-050';
  if (revision === 0xb4) return 'JDM-055';
  return null;
}

export function parseFirmwareInfo(productId, view) {
  const ds4 = [0x05c4, 0x09cc].includes(productId);
  if (!MODELS.has(productId) || !validReport(view, ds4 ? 0xa3 : 0x20, ds4 ? 49 : 64)) return null;
  const date = ascii(view, 1, ds4 ? 15 : 11), time = ascii(view, ds4 ? 16 : 12, ds4 ? 16 : 8);
  const fields = { fwBuildDate: date && time && /^[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(time) ? `${date.replace(/\s+/g, ' ')} ${time}` : null };
  const hardwareVersion = ds4 ? view.getUint16(35, true) : view.getUint32(24, true);
  fields.hwModel = hex(hardwareVersion, ds4 ? 4 : 8);
  fields.boardModel = inferBoardModel(productId, hardwareVersion);
  if (ds4) fields.fwVersion = hex(view.getUint16(41, true), 4);
  else Object.assign(fields, {
    fwType: hex(view.getUint16(20, true), 4), fwSeries: hex(view.getUint16(22, true), 4), fwVersion: hex(view.getUint32(28, true)),
    fwUpdate: hex(view.getUint16(44, true), 4), fwUpdateInfo: hex(view.getUint8(46), 2),
    sblVersion: hex(view.getUint32(48, true)), venomVersion: hex(view.getUint32(52, true)), spiderVersion: hex(view.getUint32(56, true)),
  });
  return fields;
}

export function parseBluetoothAddress(productId, view) {
  const ds4 = [0x05c4, 0x09cc].includes(productId);
  if (!MODELS.has(productId) || !validReport(view, ds4 ? 0x12 : 9, ds4 ? 16 : 20)) return null;
  const bytes = Array.from({ length: 6 }, (_, i) => view.getUint8(6 - i));
  return bytes.every(byte => byte === 0) || bytes.every(byte => byte === 255) ? null : bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

export function parseManufacturingInfo(id, view) {
  const query = MANUFACTURING.find(query => query.id === id);
  if (!query || !validReport(view, 0x81, 64) || view.getUint8(1) !== 1 || view.getUint8(2) !== query.selector || view.getUint8(3) !== 2) return null;
  if (query.hex) {
    const bytes = Array.from({ length: query.length }, (_, i) => view.getUint8(i + 4));
    return bytes.every(byte => byte === 0) || bytes.every(byte => byte === 255) ? null : bytes.map(byte => byte.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  const value = ascii(view, 4, query.length);
  return value && query.reverse ? [...value].reverse().join('') : value;
}

function baseInfo(state, record) {
  const model = MODELS.get(record?.device?.productId) || state?.model || state?.name || null;
  const info = { key: state?.key || null, status: 'idle', message: 'Read controller information to load software and hardware details.', model, vendorId: record?.device?.vendorId ?? null, productId: record?.device?.productId ?? null, transport: state?.transport || null, software: rows(SOFTWARE), hardware: rows(HARDWARE) };
  set(info, 'model', model, record ? 'USB device identity' : 'Browser device name');
  set(info, 'deviceType', null, null, 'Authenticity cannot be established from USB identifiers.');
  if (record) {
    set(info, 'vendorId', hex(record.device.vendorId, 4), 'USB device identity');
    set(info, 'productId', hex(record.device.productId, 4), 'USB device identity');
  }
  return info;
}

export class ControllerInfoReader {
  constructor({ getRecord, getState, onChange = () => {}, now = clock, timeoutMs = 1000 } = {}) {
    this.getRecord = getRecord || (() => null); this.getState = getState || (() => null); this.onChange = onChange; this.now = now;
    this.timeoutMs = Math.max(20, Math.min(2000, timeoutMs)); this.generation = 0; this.activeRun = null; this.info = null; this.blocked = new WeakSet(); this.closed = false;
  }

  supported(record = this.getRecord(), state = this.getState()) {
    const age = this.now() - record?.timestamp;
    return !this.closed && record?.device?.opened === true && record.device.vendorId === 0x054c && MODELS.has(record.device.productId) && typeof record.device.receiveFeatureReport === 'function' && record.parsed?.transport === 'usb' && state?.key === record.key && state.source === 'hid' && state.transport === 'usb' && Number.isFinite(age) && age >= 0 && age <= 1000;
  }

  get() {
    const state = this.getState(), record = this.getRecord();
    if (this.info?.key === state?.key && this.info) return copy(this.info);
    const info = baseInfo(state, record);
    if (!this.supported(record, state)) {
      info.status = 'unsupported';
      info.message = 'Connect PlayStation over USB to read software and hardware details.';
    }
    return info;
  }

  invalidate() {
    this.generation++;
    if (this.activeRun) { this.activeRun.cancelled = true; this.activeRun.cancel(); }
    this.activeRun = null; this.info = null; this.onChange();
  }

  valid(run) {
    return this.activeRun === run && this.generation === run.generation && !run.cancelled && this.getRecord() === run.record && this.supported(run.record, this.getState());
  }

  async transfer(run, operation) {
    const work = Promise.resolve(run.record.outputTail).catch(() => {}).then(async () => {
      if (!this.valid(run)) throw cancelled();
      const result = await operation();
      if (!this.valid(run)) throw cancelled();
      return result;
    });
    run.record.outputTail = work.catch(() => {});
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => { run.cancelled = true; this.blocked.add(run.record); reject(Object.assign(new Error('Controller information request timed out. Reconnect the controller to retry.'), { name: 'TimeoutError' })); }, this.timeoutMs); });
    try { return await Promise.race([work, deadline, run.stopped]); }
    finally { clearTimeout(timer); }
  }

  async read() {
    const record = this.getRecord(), state = this.getState();
    if (this.activeRun && this.activeRun.key === state?.key) return this.activeRun.promise;
    if (!this.supported(record, state)) return this.get();
    this.invalidate();
    if (this.blocked.has(record)) {
      this.info = { ...baseInfo(state, record), status: 'error', message: 'The previous request stalled. Reconnect the controller to retry.' }; this.onChange(); return this.get();
    }
    const run = { key: state.key, record, generation: this.generation, cancelled: false };
    run.stopped = new Promise((_, reject) => { run.cancel = () => reject(cancelled()); });
    run.stopped.catch(() => {});
    this.activeRun = run;
    this.info = { ...baseInfo(state, record), status: 'loading', message: 'Reading controller software and hardware details…' };
    run.promise = Promise.resolve().then(() => this.collect(run)).finally(() => { if (this.activeRun === run) this.activeRun = null; });
    this.onChange();
    return run.promise;
  }

  async collect(run) {
    if (!this.valid(run)) return this.get();
    const info = copy(this.info), { device } = run.record, ds4 = [0x05c4, 0x09cc].includes(device.productId);
    let completed = 0, unavailable = 0;
    const errors = [];
    const receive = async (id, length, parse) => {
      if (featureReportLength(device, id) !== length - 1) { unavailable++; return; }
      try {
        const result = await this.transfer(run, () => device.receiveFeatureReport(id));
        const fields = parse(result);
        if (!fields) throw new Error('The controller returned an invalid information report.');
        for (const [field, value] of Object.entries(fields)) set(info, field, value, `USB feature ${hex(id, 2)}`);
        completed++;
      } catch (error) { if (['TimeoutError', 'AbortError'].includes(error.name)) throw error; errors.push(error.message); }
    };
    try {
      await receive(ds4 ? 0xa3 : 0x20, ds4 ? 49 : 64, view => parseFirmwareInfo(device.productId, view));
      await receive(ds4 ? 0x12 : 9, ds4 ? 16 : 20, view => { const value = parseBluetoothAddress(device.productId, view); return value ? { bluetoothAddress: value } : null; });
      const manufacturingSupported = !ds4 && typeof device.sendFeatureReport === 'function' && featureReportLength(device, 0x80) === 63 && featureReportLength(device, 0x81) === 63;
      if (manufacturingSupported) {
        for (const query of MANUFACTURING) {
          try {
            // Only fixed identity selectors are allowed; request and response own the shared device queue together.
            const response = await this.transfer(run, async () => {
              const request = new Uint8Array(63); request.set([1, query.selector]);
              await device.sendFeatureReport(0x80, request);
              if (!this.valid(run)) throw cancelled();
              return device.receiveFeatureReport(0x81);
            });
            const value = parseManufacturingInfo(query.id, response);
            if (value === null) { unavailable++; continue; }
            set(info, query.id, value, `USB identity query 1/${query.selector}`); completed++;
          } catch (error) { if (['TimeoutError', 'AbortError'].includes(error.name)) throw error; errors.push('A manufacturing detail could not be read.'); }
        }
      } else unavailable += MANUFACTURING.length;
      const serial = info.hardware.find(field => field.id === 'serialNumber').value;
      if (serial) set(info, 'color', COLORS.get(serial.slice(4, 6)) || null, 'Serial-number color code', 'Inferred from the serial number; a replacement shell may differ.');
      const board = info.hardware.find(field => field.id === 'boardModel');
      if (board.value) board.note = 'Inferred from the reported hardware revision.';
      if (!this.valid(run)) throw cancelled();
      const incomplete = unavailable || errors.length || [...info.software, ...info.hardware].some(field => field.value === null);
      info.status = completed ? (incomplete ? 'partial' : 'ready') : errors.length ? 'error' : 'unsupported';
      info.message = completed ? (incomplete ? 'Controller details loaded. Some fields are unavailable.' : 'Controller details loaded.') : errors.length ? 'Controller details could not be read. Reconnect over USB and retry.' : 'This controller does not expose the supported information reports.';
    } catch (error) {
      if (error.name === 'AbortError' || this.activeRun !== run || this.generation !== run.generation) return this.get();
      info.status = 'error'; info.message = error.message;
    }
    if (this.activeRun === run && this.getState()?.key === run.key && this.getRecord() === run.record) { this.info = info; this.onChange(); }
    return this.get();
  }

  dispose() { this.closed = true; this.invalidate(); }
}
