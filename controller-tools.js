const $ = id => document.getElementById(id);
const write = (id, value) => { const node = $(id); if (node.textContent !== value) node.textContent = value; };

export class ControllerToolsUI {
  constructor({ hub, isGuidedRunning = () => false }) {
    this.hub = hub;
    this.isGuidedRunning = isGuidedRunning;
    this.snapshot = null;
    this.busy = false;
    this.generation = 0;
    for (const [id, side] of [['effects-left', 'left'], ['effects-right', 'right'], ['effects-both', 'both']]) {
      $(id).addEventListener('click', () => this.run('adaptiveTriggers', side));
    }
    $('effects-lights').addEventListener('click', () => this.run('lights'));
    $('effects-stop').addEventListener('click', () => this.stop());
    this.progress = event => {
      const detail = event.detail;
      write('effects-status', detail.label || 'Test in progress.');
      if (detail.kind === 'lights') {
        if (detail.color) $('effects-swatch').style.backgroundColor = `rgb(${detail.color.join(',')})`;
        write('effects-light-label', detail.label || 'RGB · player 1–5 · mic indicator');
      }
    };
    hub.addEventListener('effectsprogress', this.progress);
    this.hidden = () => { if (document.hidden) void this.stop(); };
    document.addEventListener('visibilitychange', this.hidden);
  }

  update(snapshot) {
    this.snapshot = snapshot;
    const guided = this.isGuidedRunning();
    for (const id of ['effects-left', 'effects-right', 'effects-both']) $(id).disabled = guided || this.busy || snapshot?.adaptiveTriggers !== true;
    $('effects-lights').disabled = guided || this.busy || snapshot?.lights !== true;
    $('effects-stop').disabled = !this.busy;
    write('effects-support', guided ? 'Use the controls in your full test while it is running.' : snapshot?.adaptiveTriggers || snapshot?.lights ? 'DualSense USB tests ready. Squeeze gently during resistance tests.' : 'Connect a DualSense or DualSense Edge over USB with Connect PlayStation.');
  }

  async run(kind, side) {
    if (this.busy || this.isGuidedRunning() || this.snapshot?.[kind] !== true) return;
    const generation = ++this.generation;
    const key = this.snapshot.key;
    this.busy = true;
    write('effects-status', 'Starting test…');
    this.update(this.snapshot);
    let completed = false;
    try {
      await this.hub.stopRumble();
      await this.hub.stopSpeakerTone();
      if (generation !== this.generation || this.isGuidedRunning() || this.snapshot?.key !== key || this.hub.activeKey !== key) return;
      completed = kind === 'lights' ? await this.hub.cycleLights() : await this.hub.testAdaptiveTriggers(side);
    } catch { /* The hub also reports the device-specific failure. */ }
    finally {
      if (generation === this.generation) {
        this.busy = false;
        write('effects-status', completed ? kind === 'lights' ? 'Cycle finished. Check that the colors and all indicator patterns responded.' : 'Resistance test finished. Check that the selected triggers responded.' : 'Test stopped or unavailable. Check the USB connection and try again.');
        this.update(this.snapshot);
      }
    }
  }

  async stop() {
    if (!this.busy) return;
    const generation = ++this.generation;
    this.busy = false;
    write('effects-status', 'Stopping the test…');
    this.update(this.snapshot);
    const stopped = await this.hub.stopControllerEffects();
    if (generation === this.generation) write('effects-status', stopped ? 'Test stopped. Neutral output sent.' : 'Test stopped. Reconnect the controller if the effect remains.');
  }

  dispose() {
    void this.stop();
    this.hub.removeEventListener('effectsprogress', this.progress);
    document.removeEventListener('visibilitychange', this.hidden);
  }
}
