const $ = id => document.getElementById(id);
const display = value => value === null || value === undefined || value === '' ? 'Unavailable' : String(value);
const hex = value => Number.isInteger(value) ? `0x${value.toString(16).toUpperCase().padStart(4, '0')}` : null;

export class ControllerInfoUI {
  constructor({ hub }) {
    this.hub = hub;
    this.snapshot = null;
    this.signature = '';
    this.requestedKey = null;
    this.refresh = () => this.read();
    $('info-refresh').addEventListener('click', this.refresh);
    this.changed = () => this.render();
    hub.addEventListener('controllerinfochange', this.changed);
  }

  update(snapshot, visible) {
    this.snapshot = snapshot;
    if (!snapshot) { this.requestedKey = null; this.signature = ''; }
    if (!visible || !snapshot) return;
    this.render();
    if (this.requestedKey !== snapshot.key) {
      this.requestedKey = snapshot.key;
      void this.read();
    }
  }

  async read() {
    if (!this.snapshot) return;
    this.requestedKey = this.snapshot.key;
    await this.hub.readControllerInfo();
    this.render();
  }

  rows(id, fields) {
    const list = $(id);
    list.replaceChildren();
    for (const field of fields || []) {
      const row = document.createElement('div');
      row.className = 'info-row';
      const label = document.createElement('dt');
      label.textContent = field.label;
      const value = document.createElement('dd');
      value.textContent = display(field.value);
      if (field.value === null || field.value === undefined) value.className = 'is-unavailable';
      if (field.note) {
        const note = document.createElement('small');
        note.textContent = field.note;
        value.append(note);
      }
      row.append(label, value);
      list.append(row);
    }
  }

  render() {
    if (!this.snapshot) return;
    const info = this.hub.getControllerInfo();
    const state = this.snapshot;
    if (info.key !== state.key) {
      this.signature = '';
      for (const id of ['info-connection', 'info-software', 'info-hardware']) $(id).replaceChildren();
      return;
    }
    const busy = info.status === 'loading';
    $('info-refresh').disabled = busy || state.source !== 'hid';
    $('info-refresh').textContent = busy ? 'Reading controller info…' : 'Read controller info';
    $('info-status').textContent = info.message || (busy ? 'Reading controller information over USB.' : 'Controller information loaded.');
    $('info-status').classList.toggle('error', info.status === 'error');
    $('page-info').setAttribute('aria-busy', String(busy));
    const connection = [
      { label: 'Name', value: state.name },
      { label: 'Model', value: state.model || info.model || null },
      { label: 'Connection', value: state.source === 'hid' ? 'PlayStation USB' : 'Browser Gamepad API' },
      { label: 'Input mapping', value: state.mapping === 'standard' ? 'Standard' : 'Raw' },
      { label: 'Vendor ID', value: hex(info.vendorId) },
      { label: 'Product ID', value: hex(info.productId) },
    ];
    const signature = JSON.stringify([state.key, info.status, connection, info.software, info.hardware]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.rows('info-connection', connection);
    this.rows('info-software', info.software);
    this.rows('info-hardware', info.hardware);
  }

  dispose() {
    $('info-refresh').removeEventListener('click', this.refresh);
    this.hub.removeEventListener('controllerinfochange', this.changed);
  }
}
