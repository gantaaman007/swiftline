// Shell: hash router + live data store (window.SW) shared by the design screens.
(function () {
  const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const roundDown2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
  const CORRIDORS = [
    { code: 'INR', country: 'India', rate: 83 }, { code: 'MXN', country: 'Mexico', rate: 17.1 },
    { code: 'PHP', country: 'Philippines', rate: 56.5 }, { code: 'NGN', country: 'Nigeria', rate: 1500 },
  ];
  const SW = {
    fmt, roundDown2, CORRIDORS, views: null, error: '',
    flow: { amount: '500', target: 'INR', method: 'bank' },
    async api(path, body) {
      const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Request failed');
      return j;
    },
    async refresh() { SW.views = await SW.api('views'); },
    list(role, name) { return ((SW.views && SW.views[role]) || []).filter((c) => c.name === name); },
    isSender: (p) => String(p).startsWith('swiftline_sender::'),
    freeUsd() { return SW.list('sender', 'Holding').filter((h) => SW.isSender(h.args.owner) && h.args.currency === 'USD').reduce((a, h) => a + Number(h.args.amount), 0); },
    stakes() { return SW.list('sender', 'Stake'); },
    stakedUsd() { return SW.stakes().reduce((a, s) => a + Number(s.args.principal), 0); },
    interestSoFar() {
      const now = Date.now();
      return SW.stakes().reduce((a, s) => {
        const end = Math.min(now, new Date(s.args.maturesAt).getTime());
        return a + Number(s.args.principal) * Number(s.args.apr) * Math.max(0, end - new Date(s.args.startedAt).getTime()) / (365 * 86400000);
      }, 0);
    },
    receipts() { return SW.list('sender', 'Receipt').slice().sort((a, b) => new Date(b.args.settledAt) - new Date(a.args.settledAt)); },
    escrow() { return SW.list('sender', 'RemitTransfer'); },
    quoteMath(amount, rate) {
      const fee = amount === 0 ? 0 : roundDown2(Math.max(1.5, amount * 0.006));
      return { fee, receive: roundDown2(Math.max(0, amount - fee) * rate) };
    },
    go(h) { location.hash = h; },
  };
  window.SW = SW;

  const host = document.getElementById('screen');
  const styleEl = document.getElementById('screen-style');
  const stage = document.getElementById('stage');
  let current = null, seq = 0;

  function fit(width) {
    stage.style.maxWidth = width > 400 ? '' : '390px';
    if (width > 400) { host.style.cssText = ''; stage.className = 'wide'; document.body.className = 'wide'; return; }
    stage.className = 'phone'; document.body.className = 'phone';
    const s = Math.min(1, (window.innerHeight - 24) / 844);
    host.style.cssText = `width:390px;height:844px;transform:scale(${s});transform-origin:top center;`;
    stage.style.height = Math.round(844 * s) + 'px';
  }

  async function route() {
    const h = location.hash;
    if (h && !h.startsWith('#/')) return; // in-page anchors such as #how
    const name = (h.slice(2).split('?')[0]) || 'Main';
    const mine = ++seq;
    if (current) current._r = null;
    host.replaceChildren();
    try {
      const m = await DCRuntime.mount(name, host, styleEl);
      if (mine !== seq) { m.inst._r = null; return; }
      current = m.inst; fit(m.width);
      window.scrollTo(0, 0);
    } catch (e) { host.textContent = e.message; }
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', () => { if (document.body.className === 'phone') fit(390); });
  route();
})();
