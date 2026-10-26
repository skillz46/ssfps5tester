// Browser audio checks are separate from controller input. A device label and
// the user's confirmation establish the route; a default route is not a pad test.
const contextType = () => globalThis.AudioContext || globalThis.webkitAudioContext || globalThis.window?.AudioContext || globalThis.window?.webkitAudioContext;
const mediaDevices = () => globalThis.navigator?.mediaDevices;
const event = (name, detail) => typeof CustomEvent === 'function' ? new CustomEvent(name, { detail }) : Object.assign(new Event(name), { detail });
const defaultOutput = () => ({ deviceId: '', label: 'System default', kind: 'audiooutput', groupId: '' });

/** RMS amplitude of unsigned, 8-bit time-domain samples, normalized to 0..1. */
export function rmsLevel(bytes) {
  if (!bytes?.length) return 0;
  let sum = 0;
  for (const byte of bytes) {
    const value = Number.isFinite(byte) ? (Math.min(255, Math.max(0, byte)) - 128) / 128 : 0;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / bytes.length));
}

export class AudioChecks extends EventTarget {
  constructor() {
    super();
    this.inputs = [];
    this.outputs = [defaultOutput()];
    this.selectedInput = '';
    this.selectedOutput = '';
    this.inputLabel = '';
    this.outputRoute = 'system-default';
    this.micState = 'idle';
    this.level = 0;
    this.peak = 0;
    this._micGeneration = 0;
    this._toneGeneration = 0;
    this._deviceGeneration = 0;
    this._closing = new Set();
    this._devices = mediaDevices();
    this._onDevices = () => { void this.refreshDevices(); };
    this._onPageHide = () => { this.stopMic(); this.stopTone(); };
    this._devices?.addEventListener?.('devicechange', this._onDevices);
    globalThis.addEventListener?.('pagehide', this._onPageHide);
  }

  _change() { this.dispatchEvent(event('change')); }
  _status(kind, message) { this.dispatchEvent(event('status', { kind, message })); }

  async refreshDevices() {
    if (this._disposed) return { inputs: this.inputs, outputs: this.outputs };
    const generation = ++this._deviceGeneration;
    try {
      const devices = await mediaDevices()?.enumerateDevices?.() || [];
      if (this._disposed || generation !== this._deviceGeneration) return { inputs: this.inputs, outputs: this.outputs };
      const normalize = (device, index, type) => ({
        deviceId: device.deviceId || '', groupId: device.groupId || '', kind: type,
        label: device.label || `${type === 'audioinput' ? 'Microphone' : 'Audio output'} ${index + 1} (name hidden)`,
      });
      this.inputs = devices.filter(device => device.kind === 'audioinput').map((device, index) => normalize(device, index, 'audioinput'));
      this.outputs = [defaultOutput(), ...devices.filter(device => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default').map((device, index) => normalize(device, index, 'audiooutput'))];
      this._change();
    } catch {
      if (!this._disposed && generation === this._deviceGeneration) this._status('error', 'Audio device names are unavailable. Check browser permissions.');
    }
    return { inputs: this.inputs, outputs: this.outputs };
  }

  _closeContext(context) {
    if (!context || context.state === 'closed') return;
    try {
      const closing = Promise.resolve(context.close()).catch(() => {});
      this._closing.add(closing);
      void closing.then(() => this._closing.delete(closing));
    } catch { /* Already closed or unavailable. */ }
  }

  _stopTracks(stream) {
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop(); } catch { /* Continue cleaning other tracks. */ }
    }
  }

  async startMic(deviceId = '') {
    this.stopMic();
    if (this._disposed) return false;
    const Context = contextType();
    if (!mediaDevices()?.getUserMedia || !Context) {
      this.micState = 'unsupported';
      this._status('unsupported', 'Microphone testing needs browser microphone access and Web Audio. Try Chrome or Edge over HTTPS.');
      this._change();
      return false;
    }
    const generation = ++this._micGeneration;
    this.selectedInput = '';
    this.inputLabel = '';
    this.level = 0;
    this.peak = 0;
    this.micState = 'idle';
    this._change();
    let stream, context;
    try {
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      if (deviceId) audio.deviceId = { exact: deviceId };
      stream = await mediaDevices().getUserMedia({ audio, video: false });
      if (this._disposed || generation !== this._micGeneration) { this._stopTracks(stream); return false; }
      const track = stream.getAudioTracks?.()[0] || stream.getTracks?.().find(track => track.kind === 'audio');
      if (!track) throw new Error('No audio input track was returned.');
      const actualId = track.getSettings?.()?.deviceId || '';
      const systemAlias = deviceId === 'default' || deviceId === 'communications';
      if (deviceId && !systemAlias && actualId && actualId !== deviceId) throw new Error('The browser selected a different microphone. Choose the controller microphone again.');
      context = new Context();
      await context.resume?.();
      if (this._disposed || generation !== this._micGeneration) { this._stopTracks(stream); this._closeContext(context); return false; }
      const source = context.createMediaStreamSource(stream), analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this._stream = stream;
      this._micContext = context;
      this._micSource = source;
      this._analyser = analyser;
      this._micTrack = track;
      this._onTrackEnded = () => {
        if (generation === this._micGeneration) {
          this.stopMic();
          this._status('info', 'The microphone input ended. Reconnect or select an input to try again.');
        }
      };
      track.addEventListener?.('ended', this._onTrackEnded);
      this.selectedInput = actualId;
      this.inputLabel = track.label || this.inputs.find(input => actualId && input.deviceId === actualId)?.label || 'Browser-selected microphone';
      this.micState = 'running';
      const bytes = new Uint8Array(analyser.fftSize);
      const update = () => {
        if (this._disposed || generation !== this._micGeneration || this.micState !== 'running') return;
        try {
          analyser.getByteTimeDomainData(bytes);
          this.level = rmsLevel(bytes);
          this.peak = Math.max(this.peak, this.level);
          this._change();
          if (this._disposed || generation !== this._micGeneration || this.micState !== 'running') return;
          if (typeof globalThis.requestAnimationFrame === 'function') {
            this._frame = globalThis.requestAnimationFrame(update);
            this._frameIsTimeout = false;
          } else {
            this._frame = setTimeout(update, 50);
            this._frameIsTimeout = true;
          }
        } catch {
          this.stopMic();
          this.micState = 'error';
          this._status('error', 'The microphone meter stopped. Check the audio input and try again.');
          this._change();
        }
      };
      update();
      if (this.micState !== 'running' || generation !== this._micGeneration) return false;
      void this.refreshDevices();
      this._status('info', `Monitoring ${this.inputLabel}. Confirm that this is your controller microphone.`);
      return this.micState === 'running';
    } catch (error) {
      this._stopTracks(stream);
      this._closeContext(context);
      if (!this._disposed && generation === this._micGeneration) {
        this.micState = 'error';
        const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
        this._status('error', denied ? 'Microphone access was denied. Allow access in your browser to test the selected input.' : error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError' ? 'The selected microphone is unavailable. Connect it and refresh the input list.' : error?.message || 'Microphone access failed. Check the selected input.');
        this._change();
      }
      return false;
    }
  }

  stopMic() {
    this._micGeneration += 1;
    if (this._frame != null) {
      if (this._frameIsTimeout) clearTimeout(this._frame);
      else globalThis.cancelAnimationFrame?.(this._frame);
    }
    this._frame = null;
    this._micTrack?.removeEventListener?.('ended', this._onTrackEnded);
    this._stopTracks(this._stream);
    try { this._micSource?.disconnect(); } catch { /* Already disconnected. */ }
    try { this._analyser?.disconnect(); } catch { /* Already disconnected. */ }
    this._closeContext(this._micContext);
    this._stream = this._micContext = this._micSource = this._analyser = this._micTrack = null;
    this.level = 0;
    if (this.micState === 'running' || this.micState === 'idle') this.micState = 'stopped';
    this._change();
  }

  async playTone(deviceId = '') {
    this.stopTone();
    if (this._disposed) return false;
    const Context = contextType();
    if (!Context) {
      this._status('unsupported', 'This browser does not support Web Audio speaker testing.');
      return false;
    }
    const generation = ++this._toneGeneration;
    let context;
    try {
      context = new Context();
      this._toneContext = context;
      if (deviceId) {
        if (typeof context.setSinkId !== 'function') {
          this.stopTone();
          this._status('unsupported', 'This browser cannot select an audio output. Choose the controller as your system output, then use System default.');
          return false;
        }
        await context.setSinkId(deviceId);
      }
      await context.resume?.();
      if (this._disposed || generation !== this._toneGeneration) { this._closeContext(context); return false; }
      const oscillator = context.createOscillator(), gain = context.createGain();
      this._oscillator = oscillator;
      this._gain = gain;
      oscillator.type = 'sine';
      const now = context.currentTime;
      oscillator.frequency.setValueAtTime(440, now);
      oscillator.frequency.setValueAtTime(660, now + 0.35);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.06, now + 0.025);
      gain.gain.setValueAtTime(0.06, now + 0.65);
      gain.gain.linearRampToValueAtTime(0, now + 0.7);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.onended = () => { if (generation === this._toneGeneration) this.stopTone(); };
      oscillator.start(now);
      oscillator.stop(now + 0.72);
      this._toneTimer = setTimeout(() => { if (generation === this._toneGeneration) this.stopTone(); }, 800);
      this.selectedOutput = deviceId;
      this.outputRoute = deviceId ? this.outputs.find(output => output.deviceId === deviceId)?.label || 'Selected audio output' : 'system-default';
      this._change();
      this._status('info', `Playing a quiet tone through ${this.outputRoute === 'system-default' ? 'System default' : this.outputRoute}. Confirm that it comes from the controller speaker.`);
      return true;
    } catch {
      if (generation === this._toneGeneration) {
        this.stopTone();
        this._status('error', 'The tone could not play through the selected output. Check the audio route and try again.');
      } else this._closeContext(context);
      return false;
    }
  }

  stopTone() {
    this._toneGeneration += 1;
    clearTimeout(this._toneTimer);
    this._toneTimer = null;
    if (this._oscillator) {
      this._oscillator.onended = null;
      try { this._oscillator.stop(); } catch { /* Already stopped. */ }
      try { this._oscillator.disconnect(); } catch { /* Already disconnected. */ }
    }
    try { this._gain?.disconnect(); } catch { /* Already disconnected. */ }
    this._closeContext(this._toneContext);
    this._toneContext = this._oscillator = this._gain = null;
    this._change();
  }

  async dispose() {
    this._disposed = true;
    this._deviceGeneration += 1;
    this._devices?.removeEventListener?.('devicechange', this._onDevices);
    globalThis.removeEventListener?.('pagehide', this._onPageHide);
    this.stopMic();
    this.stopTone();
    await Promise.all([...this._closing]);
  }
}
