export const PAGE_TITLES = Object.freeze({ home: 'Home', test: 'Full test', inputs: 'Live inputs', info: 'Controller info' });

export function pageFromHash(hash = '') {
  const page = hash.replace(/^#\/?/, '').replace(/\/$/, '') || 'home';
  if (page === 'sticks') return 'inputs';
  return Object.hasOwn(PAGE_TITLES, page) ? page : 'home';
}

export function visiblePage(hash, connected) {
  return connected ? pageFromHash(hash) : 'home';
}

export class ControllerPages {
  constructor({ onChange = () => {}, document = globalThis.document, window = globalThis.window } = {}) {
    this.document = document;
    this.window = window;
    this.onChange = onChange;
    this.connected = false;
    this.page = null;
    this.handleHash = () => this.render(true);
    window.addEventListener('hashchange', this.handleHash);
    this.render(false);
  }

  sync(snapshot) {
    const connected = !!snapshot;
    if (connected === this.connected) return;
    this.connected = connected;
    this.render(false);
  }

  render(focus) {
    const doc = this.document;
    const page = visiblePage(this.window.location.hash, this.connected);
    const previous = this.page;
    const focusedPage = doc.activeElement?.closest?.('.app-page');
    this.page = page;
    this.onChange({ from: previous, to: page, connected: this.connected });
    doc.body.classList.toggle('has-controller', this.connected);
    doc.body.classList.toggle('page-inputs-active', this.connected && page === 'inputs');
    for (const id of ['controller-pages', 'page-nav', 'connection-bar']) doc.getElementById(id).hidden = !this.connected;
    doc.getElementById('connection-prompt').hidden = this.connected;
    for (const element of doc.querySelectorAll('.app-page')) element.hidden = !this.connected || element.id !== `page-${page}`;
    for (const link of doc.querySelectorAll('#page-nav [data-page]')) {
      if (link.dataset.page === page) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    doc.title = `${this.connected ? `${PAGE_TITLES[page]} | ` : ''}ssfps5tester`;
    if (focus || (focusedPage && focusedPage.hidden)) {
      const target = this.connected ? doc.querySelector(`#page-${page} [data-page-title]`) : doc.querySelector('#connection-prompt h1');
      target?.focus({ preventScroll: true });
    }
    if (focus && previous !== page) this.window.scrollTo({ top: 0, behavior: 'instant' });
  }

  dispose() { this.window.removeEventListener('hashchange', this.handleHash); }
}
