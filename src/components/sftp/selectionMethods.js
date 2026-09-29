import { api } from '../../store';

/** Multi-select modifier follows the platform convention: Cmd on macOS, Ctrl elsewhere. */
function isMultiKey(e) {
  return api.platform === 'darwin' ? !!e.metaKey : !!e.ctrlKey;
}

export default {
  selProp(side) {
    return side === 'local' ? 'localSel' : 'remoteSel';
  },
  anchorProp(side) {
    return side === 'local' ? 'localAnchor' : 'remoteAnchor';
  },
  itemsOf(side) {
    return side === 'local' ? this.localItems : this.remoteItems;
  },
  selNames(side) {
    return this[this.selProp(side)] || [];
  },
  setSel(side, names, anchor) {
    this[this.selProp(side)] = names;
    if (anchor !== undefined) this[this.anchorProp(side)] = anchor;
    this.activeSide = side;
  },
  clearSel(side) {
    this.setSel(side, [], '');
  },
  selItems(side) {
    const names = this.selNames(side);
    return this.itemsOf(side).filter((x) => !x.isParent && names.indexOf(x.name) >= 0);
  },
  selectableNames(side) {
    return this.itemsOf(side)
      .filter((x) => !x.isParent)
      .map((x) => x.name);
  },
  onRowSelect(side, name, e) {
    if (!name || name === '..') return;
    const ev = e || {};
    const current = this.selNames(side);
    const anchor = this[this.anchorProp(side)];
    if (ev.shiftKey && anchor) {
      const items = this.itemsOf(side);
      const from = items.findIndex((x) => x.name === anchor);
      const to = items.findIndex((x) => x.name === name);
      if (from >= 0 && to >= 0) {
        const a = Math.min(from, to);
        const b = Math.max(from, to);
        const band = items.slice(a, b + 1).filter((x) => !x.isParent).map((x) => x.name);
        this.setSel(side, isMultiKey(ev) ? [...new Set([...current, ...band])] : band);
        return;
      }
    }
    if (isMultiKey(ev)) {
      const next = current.indexOf(name) >= 0 ? current.filter((n) => n !== name) : [...current, name];
      this.setSel(side, next, name);
      return;
    }
    this.setSel(side, [name], name);
  },
  onMarquee(side, ev) {
    if (ev.phase === 'begin') {
      this._marqueeBase = ev.additive ? this.selNames(side).slice() : [];
      this.activeSide = side;
      return;
    }
    if (ev.phase === 'move') {
      const base = this._marqueeBase || [];
      this.setSel(side, [...new Set([...base, ...ev.names])]);
      return;
    }
    this._marqueeBase = null;
  },
  onBlankClick(side) {
    this.clearSel(side);
  },
  activePanel() {
    return this.activeSide === 'remote' ? 'remote' : 'local';
  },
  onGlobalKey(e) {
    const target = e.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) return;
    if (String(e.key) === 'Escape') {
      this.closeCtx();
      this.clearSel(this.activePanel());
      return;
    }
    if (!isMultiKey(e) || e.altKey) return;
    if (String(e.key).toLowerCase() === 'a') {
      e.preventDefault();
      const side = this.activePanel();
      this.setSel(side, this.selectableNames(side));
    }
  },
};
