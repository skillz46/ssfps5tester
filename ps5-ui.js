// Console discovery uses the local helper; Remote Play opens in Chiaki.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const CHIAKI_DOWNLOAD = 'https://github.com/chiaki-ng/chiaki-ng/releases/latest';
const CHIAKI_SETUP = 'https://chiaki-ng.github.io/chiaki-ng/setup/configuration/';

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function link(label, href, className = 'ps5-link') {
  const item = element('a', className, label);
  item.href = href;
  if (href.startsWith('https:')) {
    item.target = '_blank';
    item.rel = 'noopener noreferrer';
  }
  return item;
}

function button(label, className = 'button secondary') {
  const item = element('button', className, label);
  item.type = 'button';
  return item;
}

function privateIpv4(value) {
  const pieces = value.split('.');
  if (pieces.length !== 4 || pieces.some(piece => !/^\d{1,3}$/.test(piece) || Number(piece) > 255)) return false;
  const [a, b] = pieces.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function initPs5Panel() {
  const mount = document.getElementById('ps5-panel');
  if (!mount) return () => {};
  const state = { status: null, consoles: [], busy: null, disposed: false, controller: null };
  const isLocal = LOCAL_HOSTS.has(window.location.hostname);
  mount.replaceChildren();
  const panel = element('section', 'panel ps5-panel');
  panel.setAttribute('aria-labelledby', 'ps5-heading');
  const top = element('div', 'ps5-top');
  const copy = element('div', 'ps5-intro');
  const heading = element('h2', '', 'PS5 Remote Play');
  heading.id = 'ps5-heading';
  const description = element('p', '', 'Find your console and open Remote Play from this computer.');
  copy.append(heading, description);
  const actions = element('div', 'ps5-actions');
  const scan = button('Find consoles', 'button primary');
  const open = button('Open Remote Play setup');
  actions.append(scan, open);
  top.append(copy, actions);
  const status = element('p', 'ps5-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const notice = element('p', 'ps5-message');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  notice.hidden = true;
  const list = element('div', 'ps5-console-list');
  list.setAttribute('aria-label', 'Discovered consoles');
  const empty = element('div', 'ps5-empty');
  empty.append(element('span', 'ps5-console-icon', '▯'), element('p', '', 'No console selected.'), element('span', '', 'Connect this computer and your PS5 to the same network, then select Find consoles.'));
  list.append(empty);
  const details = element('details', 'ps5-advanced');
  details.append(element('summary', '', 'Find a console by its address'));
  const form = element('form', 'ps5-host-form');
  const field = element('div', 'ps5-host-field');
  const label = element('label', '', 'PS5 local IP address');
  label.htmlFor = 'ps5-host';
  const host = element('input');
  host.id = 'ps5-host';
  host.name = 'host';
  host.type = 'text';
  host.inputMode = 'decimal';
  host.placeholder = '192.168.1.50';
  host.autocomplete = 'off';
  host.spellcheck = false;
  host.setAttribute('aria-describedby', 'ps5-host-help');
  field.append(label, host);
  const findHost = button('Find this console');
  findHost.type = 'submit';
  form.append(field, findHost);
  const hostHelp = element('p', 'ps5-fine', 'On PS5: Settings → Network → Connection Status → View Connection Status. Use its local IPv4 address.');
  hostHelp.id = 'ps5-host-help';
  details.append(form, hostHelp);
  const help = element('details', 'ps5-setup');
  help.append(element('summary', '', 'First time? Set up your PS5'));
  const steps = element('ol');
  for (const text of [
    'On PS5, open Settings → System → Remote Play and turn on Enable Remote Play.',
    'For waking from rest mode, open System → Power Saving → Features Available in Rest Mode. Enable Stay Connected to the Internet and Enable Turning On PS5 from Network.',
    'Open Remote Play setup to pair your console in Chiaki. Sign in and enter pairing details only in that app.',
  ]) steps.append(element('li', '', text));
  help.append(steps, link('Chiaki pairing guide ↗', CHIAKI_SETUP));
  const foot = element('div', 'ps5-footer');
  const wakeNote = element('p', 'ps5-wake-note');
  wakeNote.hidden = true;
  foot.append(element('p', '', 'Remote Play opens in a separate Chiaki window. Connect your controller to this computer for controller tests.'));
  foot.append(wakeNote);
  panel.append(top, status, notice, list, details, help, foot);
  mount.append(panel);

  function showMessage(message, error = false) {
    notice.textContent = message;
    notice.classList.toggle('is-error', error);
    notice.hidden = !message;
  }

  function capability(name) {
    return state.status?.available === true && state.status?.capabilities?.[name] === true;
  }

  function renderActions() {
    const busy = !!state.busy;
    panel.setAttribute('aria-busy', String(busy));
    scan.disabled = busy || !capability('scan');
    scan.textContent = state.busy === 'scan' ? 'Finding consoles…' : 'Find consoles';
    open.disabled = busy || !capability('openClient');
    open.textContent = state.busy === 'open' ? 'Opening…' : 'Open Remote Play setup';
    findHost.disabled = busy || !capability('scan');
    host.disabled = busy || !capability('scan');
    description.textContent = capability('wake') ? 'Find your console, wake it from rest mode, and open Remote Play.' : 'Find your console and open Remote Play from this computer.';
    wakeNote.hidden = !state.status || capability('wake');
    wakeNote.textContent = 'Use the Chiaki window to wake a paired console or put it into rest mode.';
    for (const item of list.querySelectorAll('button[data-action]')) {
      item.disabled = busy || !capability(item.dataset.action) || item.dataset.unavailable === 'true';
    }
  }

  async function api(path, body) {
    const controller = new AbortController();
    state.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api/ps5/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-SSFPS5Tester-Token': state.status?.csrfToken || '' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      let data;
      try { data = await response.json(); } catch { throw new Error('The local PS5 helper is unavailable. Start the ssfps5tester server, then reload this page.'); }
      if (!response.ok || data?.ok === false) {
        const detail = typeof data?.error === 'string' ? data.error : data?.error?.message;
        throw new Error(detail || data?.message || `This request could not be completed (${response.status}).`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The request took too long. Check your network and try again.');
      if (error instanceof TypeError) throw new Error('The local PS5 helper could not be reached. Start ssfps5tester on this computer, then reload the page.');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (state.controller === controller) state.controller = null;
    }
  }

  async function action(name, work) {
    if (state.busy || state.disposed) return;
    state.busy = name;
    showMessage('');
    renderActions();
    try { await work(); }
    catch (error) { if (!state.disposed) showMessage(error.message || 'This request could not be completed.', true); }
    finally { state.busy = null; if (!state.disposed) renderActions(); }
  }

  function renderConsoles() {
    list.replaceChildren();
    if (!state.consoles.length) {
      const noResults = element('div', 'ps5-empty');
      noResults.append(element('span', 'ps5-console-icon', '▯'), element('p', '', 'No consoles found yet.'), element('span', '', 'Check that your PS5 is on or in rest mode and on the same network. You can also try its IP address below.'));
      list.append(noResults);
      return;
    }
    for (const console of state.consoles) {
      const card = element('article', 'ps5-console-card');
      const identity = element('div', 'ps5-console-identity');
      const icon = element('span', 'ps5-console-icon', '▯');
      icon.setAttribute('aria-hidden', 'true');
      const text = element('div');
      text.append(element('h3', '', String(console.name || 'PlayStation 5')));
      const meta = element('p', 'ps5-console-meta');
      const knownState = ['ready', 'rest'].includes(console.state) ? console.state : 'unknown';
      const stateLabel = { ready: 'Ready', rest: 'Rest mode', unknown: 'Status unavailable' }[knownState];
      meta.append(element('span', `ps5-state ${knownState}`, stateLabel));
      if (console.address) meta.append(element('span', '', String(console.address)));
      text.append(meta);
      if (console.runningApp) text.append(element('p', 'ps5-playing', String(console.runningApp)));
      identity.append(icon, text);
      const controls = element('div', 'ps5-console-actions');
      const directWake = capability('wake');
      const wake = button(directWake ? 'Wake console' : 'Wake in Chiaki');
      wake.dataset.action = directWake ? 'wake' : 'openClient';
      wake.title = 'Wake from rest mode requires a console paired in Chiaki and PS5 network wake enabled.';
      wake.dataset.unavailable = String(console.registered === false);
      wake.addEventListener('click', () => action('wake', async () => {
        const result = directWake ? await api('wake', { id: console.id }) : await api('client/open', {});
        showMessage(result.message || 'Select your console in Chiaki to wake it. Then return here and find consoles again.');
      }));
      const needsPairing = console.registered === false;
      const connect = button(needsPairing ? 'Pair in Chiaki' : 'Connect', 'button primary');
      connect.dataset.action = needsPairing ? 'openClient' : 'connect';
      connect.dataset.unavailable = String(!needsPairing && console.canConnect === false);
      connect.addEventListener('click', () => action('connect', async () => {
        const result = needsPairing ? await api('client/open', {}) : await api('connect', { id: console.id });
        showMessage(result.message || 'Open request sent to Chiaki. Continue in its Remote Play window.');
      }));
      controls.append(wake, connect);
      card.append(identity, controls);
      if (console.registered === false) card.append(element('p', 'ps5-pair-note', 'Pair this console in Chiaki before connecting or waking it.'));
      list.append(card);
    }
    renderActions();
  }

  async function scanConsoles(address) {
    return action('scan', async () => {
      const result = await api('scan', address ? { host: address } : {});
      if (state.disposed) return;
      state.status = { ...state.status, ...result };
      state.consoles = Array.isArray(result.consoles) ? result.consoles.filter(item => item && typeof item.id === 'string') : [];
      renderConsoles();
      showMessage(state.consoles.length ? `Found ${state.consoles.length} ${state.consoles.length === 1 ? 'console' : 'consoles'}. Select Connect to open Remote Play.` : 'Search finished. No consoles replied.');
    });
  }

  scan.addEventListener('click', () => scanConsoles());
  open.addEventListener('click', () => action('open', async () => {
    const result = await api('client/open', {});
    showMessage(result.message || 'Chiaki is opening. Pair your PS5 there, then return to ssfps5tester.');
  }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const address = host.value.trim();
    if (!privateIpv4(address)) {
      host.setAttribute('aria-invalid', 'true');
      showMessage('Enter a private home-network IPv4 address, such as 192.168.1.50.', true);
      host.focus();
      return;
    }
    host.removeAttribute('aria-invalid');
    scanConsoles(address);
  });

  async function loadStatus() {
    if (!isLocal) {
      status.classList.add('ps5-status-local');
      status.append(element('span', '', 'Console control requires the local ssfps5tester server. '), link('Open local tester', 'http://localhost:4173/'));
      list.hidden = true;
      details.hidden = true;
      renderActions();
      return;
    }
    status.textContent = 'Checking the local Remote Play helper…';
    renderActions();
    try {
      state.status = await api('status');
      if (state.disposed) return;
      status.replaceChildren();
      if (state.status.available !== true) {
        status.textContent = state.status.message || 'The local PS5 helper is unavailable on this computer.';
      } else if (state.status.client?.installed === true) {
        status.classList.add('is-ready');
        status.textContent = `${state.status.client.name || 'Chiaki'} is ready · Remote Play opens in its own window`;
      } else {
        status.append(element('span', '', 'Install Chiaki to connect and pair your PS5. You can still search your network. '), link('Get Chiaki ↗', CHIAKI_DOWNLOAD));
      }
      if (Array.isArray(state.status.consoles) && state.status.consoles.length) {
        state.consoles = state.status.consoles.filter(item => item && typeof item.id === 'string');
        renderConsoles();
      }
    } catch (error) {
      if (!state.disposed) {
        status.textContent = error.message;
        status.classList.add('is-unavailable');
      }
    }
    if (!state.disposed) renderActions();
  }
  const dispose = () => {
    state.disposed = true;
    state.controller?.abort();
    window.removeEventListener('pagehide', onPageHide);
  };
  const onPageHide = event => {
    if (event.persisted) state.controller?.abort();
    else dispose();
  };
  window.addEventListener('pagehide', onPageHide);
  loadStatus();
  return dispose;
}
