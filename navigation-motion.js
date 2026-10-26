export class NavigationMotion {
  constructor({ nav = globalThis.document?.getElementById('page-nav') } = {}) {
    this.nav = nav;
    this.disposed = false;
    this.frame = 0;
    this.readyFrame = 0;
    this.previewLink = null;
    if (!nav) return;
    this.document = nav.ownerDocument;
    this.window = this.document.defaultView;
    this.links = [...nav.querySelectorAll('a[data-page]')];
    this.queue = () => {
      if (this.disposed || this.frame) return;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = 0;
        this.position();
      });
    };
    this.linkFrom = target => {
      const link = target?.closest?.('a[data-page]');
      return this.links.includes(link) ? link : null;
    };
    this.enter = event => this.preview(event.currentTarget);
    this.leave = () => this.restore();
    this.focus = event => this.preview(this.linkFrom(event.target));
    this.blur = event => this.preview(this.linkFrom(event.relatedTarget));
    this.click = () => this.restore();
    for (const link of this.links) link.addEventListener('pointerenter', this.enter);
    nav.addEventListener('pointerleave', this.leave);
    nav.addEventListener('focusin', this.focus);
    nav.addEventListener('focusout', this.blur);
    nav.addEventListener('click', this.click);
    nav.addEventListener('scroll', this.queue, { passive: true });
    this.window.addEventListener('resize', this.queue);
    this.mutations = new this.window.MutationObserver(() => this.restore());
    this.mutations.observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-current', 'hidden'] });
    if (this.window.ResizeObserver) {
      this.sizes = new this.window.ResizeObserver(this.queue);
      for (const element of [nav, ...this.links]) this.sizes.observe(element);
    }
    this.document.fonts?.ready.then(this.queue);
    this.queue();
  }

  preview(link) {
    if (!this.nav || this.disposed) return;
    this.previewLink?.classList.remove('is-previewed');
    this.previewLink = link;
    link?.classList.add('is-previewed');
    this.nav.classList.toggle('is-previewing', !!link);
    this.queue();
  }

  restore() { this.preview(null); }

  position() {
    if (this.disposed) return;
    const nav = this.nav;
    const selected = nav.querySelector('a[data-page][aria-current="page"]');
    const link = this.previewLink || selected;
    const visible = !nav.hidden && nav.getClientRects().length > 0;
    if (!visible || !link) {
      nav.classList.remove('is-indicator-ready');
      this.window.cancelAnimationFrame(this.readyFrame);
      this.readyFrame = 0;
      return;
    }
    const bounds = nav.getBoundingClientRect();
    const item = link.getBoundingClientRect();
    if (!item.width || !bounds.width) return;
    nav.style.setProperty('--nav-pill-x', `${Math.round((item.left - bounds.left + nav.scrollLeft) * 100) / 100}px`);
    nav.style.setProperty('--nav-pill-width', `${Math.round(item.width * 100) / 100}px`);
    if (!nav.classList.contains('is-indicator-ready') && !this.readyFrame) {
      // Position the hidden indicator before enabling its transition.
      this.readyFrame = this.window.requestAnimationFrame(() => {
        this.readyFrame = 0;
        if (!this.disposed && !nav.hidden) nav.classList.add('is-indicator-ready');
      });
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.nav) return;
    this.window.cancelAnimationFrame(this.frame);
    this.window.cancelAnimationFrame(this.readyFrame);
    this.mutations.disconnect();
    this.sizes?.disconnect();
    for (const link of this.links) {
      link.removeEventListener('pointerenter', this.enter);
      link.classList.remove('is-previewed');
    }
    this.nav.removeEventListener('pointerleave', this.leave);
    this.nav.removeEventListener('focusin', this.focus);
    this.nav.removeEventListener('focusout', this.blur);
    this.nav.removeEventListener('click', this.click);
    this.nav.removeEventListener('scroll', this.queue);
    this.window.removeEventListener('resize', this.queue);
    this.nav.classList.remove('is-previewing', 'is-indicator-ready');
    this.nav.style.removeProperty('--nav-pill-x');
    this.nav.style.removeProperty('--nav-pill-width');
    this.previewLink = null;
  }
}
