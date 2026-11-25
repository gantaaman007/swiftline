// Minimal runtime for the Swiftline design files (*.dc.html).
// It reads the original markup ({{vars}}, <sc-for>, onClick handlers) and the screen's Component class,
// so each screen looks exactly as designed. Live ledger data comes from window.SW (app.js).
(function () {
  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; this._r = null; this.sw = window.SW; }
    setState(p) { this.state = Object.assign({}, this.state, typeof p === 'function' ? p(this.state) : p); if (this._r) this._r(); }
    renderVals() { return {}; }
  }
  const look = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  const interp = (s, scope) => s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => { const v = look(scope, p); return v == null ? '' : v; });
  const EVT = { onclick: 'click', onchange: 'input', oninput: 'input' };

  function build(node, scope) {
    if (node.nodeType === 3) return document.createTextNode(interp(node.nodeValue, scope));
    if (node.nodeType !== 1) return document.createDocumentFragment();
    const tag = node.localName;
    if (tag === 'sc-for') {
      const frag = document.createDocumentFragment();
      const listExpr = (node.getAttribute('list') || '').replace(/[{}\s]/g, '');
      const as = node.getAttribute('as') || 'item';
      (look(scope, listExpr) || []).forEach((item) => {
        const child = Object.assign({}, scope, { [as]: item });
        node.childNodes.forEach((c) => frag.appendChild(build(c, child)));
      });
      return frag;
    }
    const el = document.createElementNS(node.namespaceURI, tag);
    for (const a of Array.from(node.attributes)) {
      const n = a.name, v = a.value;
      if (n === 'hint-placeholder-count') continue;
      if (EVT[n]) {
        const fn = look(scope, v.replace(/[{}\s]/g, ''));
        if (typeof fn === 'function') { el.addEventListener(EVT[n], fn); if (tag === 'a' || tag === 'button') el.style.cursor = 'pointer'; }
        continue;
      }
      let val = interp(v, scope);
      if (n === 'href') { const m = val.match(/^([A-Za-z]+)\.dc\.html$/); if (m) val = '#/' + (m[1] === 'Main' ? '' : m[1]); }
      el.setAttribute(n, val);
      if (n === 'value') el.value = val;
    }
    node.childNodes.forEach((c) => el.appendChild(build(c, scope)));
    return el;
  }

  const cache = {};
  async function loadScreen(name) {
    if (cache[name]) return cache[name];
    const res = await fetch('screens/' + name + '.dc.html');
    if (!res.ok) throw new Error('Screen not found: ' + name);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const dc = doc.querySelector('x-dc');
    const helmet = dc.querySelector('helmet');
    const css = helmet ? Array.from(helmet.querySelectorAll('style')).map((s) => s.textContent).join('\n') : '';
    if (helmet) helmet.remove();
    const tpl = document.createElement('template');
    tpl.innerHTML = dc.innerHTML;
    const script = doc.querySelector('script[data-dc-script]');
    const code = script ? script.textContent : 'class Component extends DCLogic { renderVals(){ return {}; } }';
    let width = 390;
    try { width = JSON.parse(script.getAttribute('data-props')).$preview.width; } catch (e) {}
    const Comp = new Function('DCLogic', code + '\nreturn Component;')(DCLogic);
    return (cache[name] = { tpl, css, Comp, width });
  }

  async function mount(name, host, styleEl) {
    const s = await loadScreen(name);
    styleEl.textContent = s.css;
    const inst = new s.Comp({});
    inst.sw = window.SW;
    const render = () => {
      const scroller = host.querySelector('[style*="overflow-y: auto"]');
      const top = scroller ? scroller.scrollTop : 0;
      const act = document.activeElement;
      const focusId = act && act.id && host.contains(act) ? act.id : null;
      const caret = focusId && act.selectionStart != null ? act.selectionStart : null;
      const vals = inst.renderVals();
      host.replaceChildren();
      s.tpl.content.childNodes.forEach((c) => host.appendChild(build(c, vals)));
      const sc2 = host.querySelector('[style*="overflow-y: auto"]');
      if (sc2) sc2.scrollTop = top;
      if (focusId) { const e = host.querySelector('#' + focusId); if (e) { e.focus(); if (caret != null && e.setSelectionRange) try { e.setSelectionRange(caret, caret); } catch (x) {} } }
    };
    inst._r = render;
    render();
    if (inst.load) Promise.resolve(inst.load()).then(() => inst._r && inst._r()).catch((e) => { if (window.SW) window.SW.error = e.message; inst._r && inst._r(); });
    return { inst, width: s.width };
  }
  window.DCRuntime = { mount, DCLogic };
})();
