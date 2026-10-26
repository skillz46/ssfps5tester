// Presentation only: completion marks come from the guided run's recorded
// evidence. Live inputs animate the drawing but cannot create pass marks.
const STATES = new Set(['pending', 'active', 'passed', 'needs-check', 'unsupported', 'skipped']);
const RECORDED = new Set(['active', 'passed', 'needs-check', 'skipped']);
const SIDES = ['left', 'right'];
const BUTTON_NAMES = ['Cross / A', 'Circle / B', 'Square / X', 'Triangle / Y', 'L1 / LB', 'R1 / RB', 'L2 / LT', 'R2 / RT', 'Share / Create', 'Options', 'L3', 'R3', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'PS / Home', 'Touchpad click', 'Mute', 'Fn left', 'Fn right', 'Paddle left', 'Paddle right'];
const TOUCH_CHECKS = [['tap', 'Tap + release'], ['movement', 'Slide'], ['twoContacts', 'Two fingers'], ['click', 'Click']];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, minimum = 0, maximum = 1) => finite(value) ? Math.min(maximum, Math.max(minimum, value)) : null;
const stateOf = step => STATES.has(step?.status) ? step.status : 'pending';
const fallback = step => stateOf(step) === 'passed' ? 'pending' : stateOf(step);
const seen = step => RECORDED.has(stateOf(step));
const sideMap = build => Object.fromEntries(SIDES.map((side, index) => [side, build(side, index)]));

export function getGuidedVisualState(summary = {}, snapshot = null, metrics = null) {
  const steps = new Map((Array.isArray(summary?.steps) ? summary.steps : []).map(step => [step.id, step]));
  const step = id => steps.get(id) || { status: 'pending', data: {} };
  const digital = step('buttons'), sweep = step('sticks'), trigger = step('triggers');
  const drift = step('drift'), touchpad = step('touchpad');
  const sameInput = snapshot != null && summary?.deviceKey != null && snapshot.key === summary.deviceKey && snapshot.source === summary.source;
  const live = summary?.state === 'running' && sameInput;
  const required = Array.isArray(digital.data?.required) ? digital.data.required.filter(index => Number.isInteger(index) && index >= 0 && index < 256) : [];
  // A recorded standard button list has at least eight positions and excludes
  // indices 6/7. This lets a stopped run retain its layout after disconnect.
  const historicalStandard = required.some(index => index >= 8) && !required.includes(6) && !required.includes(7);
  const standard = sameInput ? snapshot.mapping === 'standard' : historicalStandard;
  const tested = new Set(seen(digital) && Array.isArray(digital.data?.tested) ? digital.data.tested.filter(index => required.includes(index)) : []);
  const inputButtons = sameInput && Array.isArray(snapshot.buttons) ? snapshot.buttons : [];
  const buttonCount = Math.min(256, Math.max(inputButtons.length, required.length ? Math.max(...required) + 1 : 0));

  const sticks = sideMap((side, index) => {
    const data = sweep.data?.[side] || {};
    const coverage = seen(sweep) ? clamp(data.coverage) ?? 0 : 0;
    const centered = seen(sweep) && data.centered === true;
    const completed = seen(sweep) && (data.completed === true || (coverage >= 26 / 32 && centered));
    return {
      status: standard ? (completed ? 'passed' : fallback(sweep)) : 'unsupported',
      x: live && standard ? clamp(snapshot.axes?.[index * 2], -1, 1) : null,
      y: live && standard ? clamp(snapshot.axes?.[index * 2 + 1], -1, 1) : null,
      coverage, centered,
    };
  });
  const triggers = sideMap((side, index) => {
    const data = trigger.data?.[side] || {};
    const squeezed = seen(trigger) && data.squeezed === true;
    const released = seen(trigger) && data.released === true;
    const completed = seen(trigger) && (data.completed === true || (squeezed && released));
    return {
      status: standard ? (completed ? 'passed' : fallback(trigger)) : 'unsupported',
      value: live && standard ? clamp(inputButtons[6 + index]?.value) : null,
      squeezed, released,
    };
  });
  const buttons = Array.from({ length: buttonCount }, (_, index) => {
    const input = inputButtons[index];
    const mapped = standard && (index <= 16 || (sameInput && snapshot.source === 'hid'));
    return {
      index,
      mapped,
      label: mapped ? BUTTON_NAMES[index] || `Button ${index}` : `Button ${index}`,
      status: standard && (index === 6 || index === 7) ? triggers[index === 6 ? 'left' : 'right'].status : tested.has(index) ? 'passed' : required.includes(index) ? fallback(digital) : 'unsupported',
      pressed: live && (input?.pressed === true || (clamp(input?.value) ?? 0) > 0.5),
      value: live ? clamp(input?.value) : null,
    };
  });

  const center = sideMap(side => {
    const recorded = drift.data?.[side];
    const finished = ['passed', 'needs-check'].includes(stateOf(drift));
    const usable = recorded?.samples > 0 && finite(recorded?.offset) && recorded.offset >= 0;
    const measuring = live && stateOf(drift) === 'active' && drift.data?.measuringSeen === true && metrics?.drift?.state === 'measuring';
    const current = measuring ? metrics.drift[side] : null;
    return {
      status: !standard ? 'unsupported' : finished ? (usable && recorded.offset <= 0.08 ? 'passed' : 'needs-check') : fallback(drift),
      offset: finished && usable ? recorded.offset : measuring && current?.samples > 0 && finite(current?.offset) && current.offset >= 0 ? current.offset : null,
      progress: finished ? 1 : measuring ? clamp(metrics.drift.progress) ?? 0 : 0,
    };
  });

  const touchExposed = !sameInput || (snapshot.source === 'hid' && Array.isArray(snapshot.touches));
  const touchUnavailable = stateOf(touchpad) === 'unsupported' || !touchExposed;
  const checks = TOUCH_CHECKS.map(([id, label]) => ({ id, label, status: touchUnavailable ? 'unsupported' : seen(touchpad) && touchpad.data?.[id] === true ? 'passed' : fallback(touchpad) }));
  const touchHeight = /DualShock 4/i.test(snapshot?.model || snapshot?.name || '') ? 943 : 1080;
  const contacts = live && !touchUnavailable ? (snapshot.touches || []).filter(contact => contact.active === true && finite(contact.x) && finite(contact.y)).slice(0, 2).map((contact, index) => ({ x: clamp(contact.x / 1920), y: clamp(contact.y / touchHeight), id: typeof contact.id === 'string' || finite(contact.id) ? contact.id : index })) : [];
  const touch = {
    status: touchUnavailable ? 'unsupported' : stateOf(touchpad) === 'passed' && checks.every(check => check.status === 'passed') ? 'passed' : fallback(touchpad),
    contacts, checks,
  };

  const tracked = [
    ...buttons.filter(button => required.includes(button.index) && (!standard || (button.index !== 6 && button.index !== 7))),
    ...Object.values(sticks), ...Object.values(triggers), ...Object.values(center), ...checks,
  ].filter(item => item.status !== 'unsupported');
  return { live, standard, buttons, sticks, triggers, center, touch, counts: { passed: tracked.filter(item => item.status === 'passed').length, total: tracked.length } };
}
