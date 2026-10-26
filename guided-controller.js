import { getGuidedVisualState } from './guided-visual-state.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const statusLabels = { pending: 'Waiting', active: 'In progress', passed: 'Passed', 'needs-check': 'Check needed', unsupported: 'Unavailable', skipped: 'Skipped' };
const shortButtonNames = ['× Cross','○ Circle','□ Square','△ Triangle','L1','R1','L2','R2','Create / Share','Options','L3 click','R3 click','D-pad ↑','D-pad ↓','D-pad ←','D-pad →','PS / Home','Touch click','Mute','Fn left','Fn right','Paddle L','Paddle R'];
let nextPrefix = 0;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function svgNode(tag, attributes = {}) {
  const item = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  return item;
}
function text(item, value) { const next = String(value); if (item && item.textContent !== next) item.textContent = next; }
function attribute(item, key, value) { const next = String(value); if (item && item.getAttribute(key) !== next) item.setAttribute(key, next); }
function setStatus(item, state) {
  attribute(item, 'data-status', state);
  const label = statusLabels[state] || 'Waiting';
  return label;
}
function makeFeature(label) {
  const card = node('div', 'gcv-feature');
  const row = node('div', 'gcv-feature-top');
  const name = node('strong', '', label), marker = node('span', 'gcv-feature-symbol');
  marker.setAttribute('aria-hidden', 'true');
  row.append(name, marker);
  const detail = node('span', 'gcv-feature-detail', 'Waiting');
  const meter = node('div', 'gcv-feature-meter'), fill = node('span');
  meter.append(fill); card.append(row, detail, meter);
  return { card, marker, detail, fill };
}

/** Read-only rendering of evidence already recorded by the guided test. */
export class GuidedControllerView {
  constructor({ mount, sourceSvg }) {
    this.mount = mount;
    this.controls = new Map(); this.buttonTiles = new Map(); this.stickParts = {};
    this.triggerParts = {}; this.centerParts = {}; this.touchChips = new Map();
    if (!mount) return;
    this.prefix = `suite-controller-${++nextPrefix}-`;
    this.root = node('section', 'guided-controller-view');
    this.root.setAttribute('aria-label', 'Controller progress in the full test');
    const header = node('div', 'gcv-heading');
    const headingCopy = node('div');
    headingCopy.append(node('h3', '', 'Controller progress'));
    this.count = node('p', 'gcv-count', 'Press each input to mark it here.');
    headingCopy.append(this.count);
    this.mode = node('span', 'gcv-mode', 'Live inputs');
    header.append(headingCopy, this.mode);
    const legend = node('div', 'gcv-legend');
    for (const [className, label] of [['gcv-legend-pressed', 'Pressed now'], ['gcv-legend-passed', 'Passed'], ['gcv-legend-waiting', 'Waiting']]) {
      const entry = node('span'); entry.append(node('i', className), document.createTextNode(label)); legend.append(entry);
    }
    const layout = node('div', 'gcv-layout');
    this.diagram = node('div', 'gcv-diagram');
    this.rawNote = node('p', 'gcv-raw-note', 'This controller has no standard layout. Follow the numbered buttons; stick, trigger and touch checks show their available results below.');
    this.rawNote.hidden = true;
    if (sourceSvg) this.buildDiagram(sourceSvg);
    const triggers = node('div', 'gcv-triggers');
    for (const [side, label] of [['left', 'L2 / LT'], ['right', 'R2 / RT']]) {
      const card = makeFeature(label); card.card.classList.add('gcv-trigger');
      this.triggerParts[side] = card; triggers.append(card.card);
    }
    this.diagram.append(triggers);
    const progress = node('div', 'gcv-checks');
    const buttonsHeading = node('div', 'gcv-group-heading');
    buttonsHeading.append(node('h4', '', 'Buttons'));
    this.buttonCount = node('span', '', ''); buttonsHeading.append(this.buttonCount);
    this.buttonGrid = node('div', 'gcv-button-grid');
    this.buttonGrid.setAttribute('aria-label', 'Individual button results');
    const motion = node('div', 'gcv-features-grid');
    for (const [side, label] of [['left', 'Left stick'], ['right', 'Right stick']]) {
      const card = makeFeature(label); this.stickParts[side] = card; motion.append(card.card);
    }
    for (const [side, label] of [['left', 'Left center'], ['right', 'Right center']]) {
      const card = makeFeature(label); card.card.classList.add('gcv-center'); this.centerParts[side] = card; motion.append(card.card);
    }
    const touch = node('div', 'gcv-touch');
    const touchTop = node('div', 'gcv-group-heading');
    touchTop.append(node('h4', '', 'Touchpad'));
    this.touchStatus = node('span', '', 'Waiting'); touchTop.append(this.touchStatus);
    this.touchList = node('div', 'gcv-touch-checks');
    touch.append(touchTop, this.touchList);
    progress.append(touch, buttonsHeading, this.buttonGrid, motion);
    layout.append(this.diagram, this.rawNote, progress);
    this.caption = node('p', 'gcv-caption', 'Passed inputs stay green. Sweep and center both sticks, then squeeze and release each trigger.');
    this.root.append(header, legend, layout, this.caption);
    mount.replaceChildren(this.root);
  }

  buildDiagram(source) {
    const svg = source.cloneNode(true);
    this.svg = svg;
    svg.classList.add('gcv-svg');
    svg.removeAttribute('style');
    attribute(svg, 'aria-label', 'Virtual controller with live input and completed test marks');
    const oldIds = new Map();
    for (const item of [svg, ...svg.querySelectorAll('[id]')]) {
      const old = item.getAttribute('id');
      if (old) { oldIds.set(old, `${this.prefix}${old}`); item.id = `${this.prefix}${old}`; }
    }
    for (const item of svg.querySelectorAll('*')) {
      for (const name of ['href', 'xlink:href', 'fill', 'stroke', 'filter', 'clip-path', 'mask']) {
        const value = item.getAttribute(name);
        if (!value) continue;
        for (const [old, replacement] of oldIds) {
          if (value === `#${old}`) item.setAttribute(name, `#${replacement}`);
          else if (value.includes(`url(#${old})`)) item.setAttribute(name, value.replaceAll(`url(#${old})`, `url(#${replacement})`));
        }
      }
      item.classList.remove('pressed');
      if (item.hasAttribute('data-button')) {
        const index = Number(item.getAttribute('data-button'));
        item.removeAttribute('data-button'); item.classList.add('gcv-control');
        this.controls.set(index, { shape: item });
      }
    }
    this.overlay = svgNode('g', { class: 'gcv-overlay', 'aria-hidden': 'true' });
    this.sweeps = {};
    for (const [side, x] of [['left', 250], ['right', 450]]) {
      const ring = svgNode('circle', { class: 'gcv-sweep-ring', cx: x, cy: 250, r: 53, pathLength: 100, transform: `rotate(-90 ${x} 250)`, 'stroke-dasharray': '0 100' });
      this.sweeps[side] = { ring, cap: svg.querySelector(`#${this.prefix}visual-${side}-stick`) };
      this.overlay.append(ring);
    }
    this.touchDots = [svgNode('circle', { class: 'gcv-touch-dot', r: 8 }), svgNode('circle', { class: 'gcv-touch-dot', r: 8 })];
    this.overlay.append(...this.touchDots);
    for (const dot of this.touchDots) dot.style.display = 'none';
    svg.append(this.overlay);
    this.triggerText = { left: svg.querySelector(`#${this.prefix}left-trigger-outline-value`), right: svg.querySelector(`#${this.prefix}right-trigger-outline-value`) };
    this.diagram.append(svg);
  }

  feature(part, data, detail, fill) {
    const label = setStatus(part.card, data.status);
    text(part.detail, detail || label);
    attribute(part.card, 'aria-label', `${part.card.querySelector('strong').textContent}: ${label}. ${detail || ''}`);
    const width = `${Math.round(Math.max(0, Math.min(1, fill || 0)) * 100)}%`;
    if (part.fill.style.width !== width) part.fill.style.width = width;
  }

  update(summary, snapshot, metrics) {
    if (!this.mount) return;
    const view = getGuidedVisualState(summary, snapshot, metrics);
    this.root.classList.toggle('is-raw', !view.standard);
    this.diagram.hidden = !view.standard;
    this.rawNote.hidden = view.standard;
    text(this.mode, view.live ? 'Live inputs' : 'Recorded results');
    text(this.count, `${view.counts.passed} / ${view.counts.total} input checks passed`);
    this.renderButtons(view);
    for (const side of ['left', 'right']) {
      const stick = view.sticks[side], trigger = view.triggers[side], center = view.center[side];
      const stickDetail = stick.status === 'passed' ? 'Sweep + center complete' : ['unsupported', 'skipped'].includes(stick.status) ? statusLabels[stick.status] : `${Math.round(stick.coverage * 100)}% sweep${stick.centered ? ' · centered' : stick.coverage >= 0.8 ? ' · release to center' : ''}`;
      this.feature(this.stickParts[side], stick, stickDetail, stick.coverage);
      const triggerPercent = trigger.value === null ? 'N/A' : `${Math.round(trigger.value * 100)}%`;
      const triggerDetail = trigger.status === 'passed' ? (trigger.value === null ? 'Squeeze + release complete' : `${triggerPercent} · passed`) : ['unsupported', 'skipped'].includes(trigger.status) ? statusLabels[trigger.status] : `${triggerPercent} · ${trigger.squeezed ? 'release' : 'squeeze fully'}`;
      this.feature(this.triggerParts[side], trigger, triggerDetail, trigger.value);
      text(this.triggerText?.[side], triggerPercent);
      const centerDetail = center.offset === null ? (center.status === 'active' ? `${Math.round(center.progress * 100)}% measured · hands off` : statusLabels[center.status]) : `${(center.offset * 100).toFixed(1)}% offset${center.status === 'passed' ? ' · passed' : center.status === 'needs-check' ? ' · check' : ''}`;
      this.feature(this.centerParts[side], center, centerDetail, center.status === 'passed' ? 1 : center.progress);
      const sweep = this.sweeps?.[side];
      if (sweep) {
        attribute(sweep.ring, 'stroke-dasharray', `${Math.round(stick.coverage * 100)} 100`);
        attribute(sweep.ring, 'data-status', stick.status);
        if (sweep.cap) {
          attribute(sweep.cap, 'cx', (side === 'left' ? 250 : 450) + (stick.x ?? 0) * 13);
          attribute(sweep.cap, 'cy', 250 + (stick.y ?? 0) * 13);
        }
      }
    }
    text(this.touchStatus, statusLabels[view.touch.status]);
    attribute(this.touchList, 'data-status', view.touch.status);
    for (const check of view.touch.checks) {
      let chip = this.touchChips.get(check.id);
      if (!chip) { chip = node('span', 'gcv-touch-chip'); this.touchChips.set(check.id, chip); this.touchList.append(chip); }
      const label = setStatus(chip, check.status);
      text(chip, check.label);
      attribute(chip, 'aria-label', `${check.label}: ${label}`);
    }
    this.touchDots?.forEach((dot, index) => {
      const contact = view.touch.contacts[index];
      dot.style.display = contact ? '' : 'none';
      if (contact) { attribute(dot, 'cx', 231 + contact.x * 238); attribute(dot, 'cy', 48 + contact.y * 120); }
    });
    const touchControl = this.controls.get(17);
    if (touchControl) touchControl.shape.classList.toggle('is-touch-passed', view.touch.status === 'passed');
  }

  renderButtons(view) {
    const buttonByIndex = new Map(view.buttons.map(button => [button.index, button]));
    const digital = view.buttons.filter(button => !view.standard || ![6, 7].includes(button.index));
    const signature = `${view.standard}:${digital.map(button => `${button.index}:${button.mapped !== false}:${button.label}`).join('|')}`;
    if (this.buttonSignature !== signature) {
      this.buttonSignature = signature; this.buttonGrid.replaceChildren(); this.buttonTiles.clear();
      for (const button of digital) {
        const tile = node('div', 'gcv-button-tile'); tile.setAttribute('role', 'img');
        const name = node('span', 'gcv-button-name', view.standard && button.mapped !== false ? shortButtonNames[button.index] || button.label : button.label);
        tile.append(name); this.buttonGrid.append(tile); this.buttonTiles.set(button.index, { tile });
      }
    }
    const tested = digital.filter(button => button.status === 'passed').length;
    text(this.buttonCount, `${tested} / ${digital.length}`);
    for (const button of digital) {
      const { tile } = this.buttonTiles.get(button.index);
      const label = setStatus(tile, button.status);
      tile.classList.toggle('is-pressed', button.pressed);
      attribute(tile, 'aria-label', `${button.label}: ${label}${button.pressed ? ', pressed now' : ''}`);
      attribute(tile, 'title', `${button.label}: ${label}`);
    }
    for (const [index, control] of this.controls) {
      const button = buttonByIndex.get(index);
      const state = button?.mapped === false ? 'unsupported' : button?.status || 'unsupported';
      control.shape.classList.toggle('is-passed', state === 'passed');
      control.shape.classList.toggle('is-pressed', button?.mapped !== false && !!button?.pressed);
      control.shape.classList.toggle('is-unavailable', state === 'unsupported');
      attribute(control.shape, 'data-status', state);
    }
  }

  dispose() { this.mount?.replaceChildren(); }
}
