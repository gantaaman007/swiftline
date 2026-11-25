// Swiftline app server. No dependencies (Node 18+).
// Talks to the Canton JSON Ledger API with an admin token and serves the web UI.
// The browser never sees credentials.
const http = require('http');
const fs = require('fs');
const path = require('path');

const CFG = {
  port: Number(process.env.PORT || 8090),
  api: process.env.LEDGER_API || 'http://localhost:3975',
  tokenUrl: process.env.TOKEN_URL || 'http://127.0.0.1:8082/realms/AppProvider/protocol/openid-connect/token',
  tokenHost: process.env.TOKEN_HOST === undefined ? 'keycloak.localhost:8082' : process.env.TOKEN_HOST,
  clientId: process.env.VALIDATOR_CLIENT_ID || 'app-provider-validator',
  secret: process.env.VALIDATOR_SECRET || '',
  pkg: '#remittance',
};

const ROLES = ['issuer', 'provider', 'sender', 'recipient', 'regulator', 'outsider'];
const CORRIDORS = [
  { code: 'INR', country: 'India', rate: 83 },
  { code: 'MXN', country: 'Mexico', rate: 17.1 },
  { code: 'PHP', country: 'Philippines', rate: 56.5 },
  { code: 'NGN', country: 'Nigeria', rate: 1500 },
];
const FEE_RATE = 0.006, MIN_FEE = 1.5;

// ---------- token ----------
let tokenCache = { value: null, exp: 0 };
function fetchToken() {
  return new Promise((resolve, reject) => {
    const u = new URL(CFG.tokenUrl);
    const body = new URLSearchParams({
      client_id: CFG.clientId, client_secret: CFG.secret,
      grant_type: 'client_credentials', scope: 'openid',
    }).toString();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) };
    if (CFG.tokenHost) headers.Host = CFG.tokenHost;
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.access_token) return reject(new Error('Token request failed: ' + data.slice(0, 200)));
          resolve({ value: j.access_token, exp: Date.now() + Math.max(30, (j.expires_in || 300) - 30) * 1000 });
        } catch (e) { reject(new Error('Token response not JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', (e) => reject(new Error('Cannot reach Keycloak: ' + e.message)));
    req.write(body); req.end();
  });
}
async function token() {
  if (!tokenCache.value || Date.now() > tokenCache.exp) tokenCache = await fetchToken();
  return tokenCache.value;
}

// ---------- ledger helpers ----------
async function ledger(method, p, body) {
  const res = await fetch(CFG.api + p, {
    method,
    headers: { Authorization: 'Bearer ' + (await token()), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    const msg = json && json.cause ? json.cause : (typeof json === 'string' ? json : JSON.stringify(json));
    throw new Error(msg.slice(0, 600));
  }
  return json;
}

const parties = {};
let adminUser = null;
async function init() {
  if (!CFG.secret) throw new Error('Set VALIDATOR_SECRET (the app-provider-validator client secret) before starting.');
  adminUser = (await ledger('GET', '/v2/authenticated-user')).user.id;
  const existing = (await ledger('GET', '/v2/parties')).partyDetails.map((d) => d.party);
  for (const r of ROLES) {
    const hint = 'swiftline_' + r;
    let p = existing.find((x) => x.startsWith(hint + '::'));
    if (!p) p = (await ledger('POST', '/v2/parties', { partyIdHint: hint, identityProviderId: '' })).partyDetails.party;
    parties[r] = p;
  }
  const rights = [];
  for (const r of ROLES) {
    rights.push({ kind: { CanReadAs: { value: { party: parties[r] } } } });
    if (r !== 'outsider') rights.push({ kind: { CanActAs: { value: { party: parties[r] } } } });
  }
  await ledger('POST', `/v2/users/${adminUser}/rights`, { userId: adminUser, identityProviderId: '', rights });
  console.log('Parties ready:', Object.fromEntries(ROLES.map((r) => [r, parties[r].split('::')[0]])));
}

let cmdCounter = 0;
async function submit(role, command) {
  cmdCounter += 1;
  const ps = (Array.isArray(role) ? role : [role]).map((r) => parties[r]);
  const resp = await ledger('POST', '/v2/commands/submit-and-wait-for-transaction', {
    commands: { commands: [command], commandId: `swiftline-app-${Date.now()}-${cmdCounter}`, actAs: ps, readAs: ps },
  });
  if (!resp.transaction) throw new Error('Unexpected response: ' + JSON.stringify(resp).slice(0, 300));
  return (resp.transaction.events || []).filter((e) => e.CreatedEvent).map((e) => e.CreatedEvent);
}
const T = (name) => `${CFG.pkg}:${name}`;
const create = (tpl, args) => ({ CreateCommand: { templateId: T(tpl), createArguments: args } });
const exercise = (tpl, cid, choice, args) => ({ ExerciseCommand: { templateId: T(tpl), contractId: cid, choice, choiceArgument: args } });
const dec = (n) => Number(n).toFixed(2);

function simplify(ev) {
  const parts = ev.templateId.split(':');
  return { cid: ev.contractId, name: parts[parts.length - 1], module: parts[parts.length - 2], args: ev.createArgument, witnesses: ev.witnessParties || [] };
}
async function acs(role) {
  const end = (await ledger('GET', '/v2/state/ledger-end')).offset;
  const out = await ledger('POST', '/v2/state/active-contracts', {
    eventFormat: {
      filtersByParty: { [parties[role]]: { cumulative: [{ identifierFilter: { WildcardFilter: { value: { includeCreatedEventBlob: false } } } }] } },
      verbose: false,
    },
    activeAtOffset: end,
  });
  return (Array.isArray(out) ? out : [])
    .map((e) => e.contractEntry && e.contractEntry.JsActiveContract && e.contractEntry.JsActiveContract.createdEvent)
    .filter(Boolean)
    .filter((ev) => ev.packageName === 'remittance' || ev.templateId.includes('Remit.'))
    .map(simplify);
}
const holdings = (list, role, cur) => list.filter((c) => c.name === 'Holding' && c.args.owner === parties[role] && (!cur || c.args.currency === cur));
const sum = (hs) => hs.reduce((a, h) => a + Number(h.args.amount), 0);
const label = (p) => ROLES.find((r) => parties[r] === p) || p;

// ---------- business actions ----------
async function setup() {
  const made = [];
  const senderList = await acs('sender');
  const biggest = Math.max(0, ...holdings(senderList, 'sender', 'USD').map((h) => Number(h.args.amount)));
  if (biggest < 1000) {
    await submit('issuer', create('Remit.Token:Holding', { issuer: parties.issuer, owner: parties.sender, currency: 'USD', amount: '1200.0', viewers: [] }));
    made.push('1,200 USD for the sender');
  }
  const provList = await acs('provider');
  for (const c of CORRIDORS) {
    if (sum(holdings(provList, 'provider', c.code)) < 1000000) {
      await submit('issuer', create('Remit.Token:Holding', { issuer: parties.issuer, owner: parties.provider, currency: c.code, amount: '10000000.0', viewers: [] }));
      made.push(`payout funds in ${c.code}`);
    }
  }
  if (sum(holdings(provList, 'provider', 'USD')) < 1000) {
    await submit('issuer', create('Remit.Token:Holding', { issuer: parties.issuer, owner: parties.provider, currency: 'USD', amount: '10000.0', viewers: [] }));
    made.push('interest reserve in USD');
  }
  const now = Date.now();
  const hasKyc = provList.some((c) => c.name === 'KycAttestation' && c.args.subject === parties.sender && new Date(c.args.validUntil).getTime() > now + 86400000);
  if (!hasKyc) {
    await submit('provider', create('Remit.Compliance:KycAttestation', {
      provider: parties.provider, subject: parties.sender, regulator: parties.regulator,
      limitCurrency: 'USD', perTransferLimit: '2000.0', validUntil: new Date(now + 30 * 86400000).toISOString(),
    }));
    made.push('identity check for the sender');
  }
  return { made };
}

async function makeQuote({ amount, currency }) {
  const c = CORRIDORS.find((x) => x.code === currency);
  if (!c) throw new Error('Unknown currency');
  if (!(Number(amount) > 0)) throw new Error('Enter an amount');
  const evs = await submit('provider', create('Remit.Quote:Quote', {
    provider: parties.provider, sender: parties.sender, fromCurrency: 'USD', toCurrency: currency,
    rate: String(c.rate.toFixed(4)), feeRate: String(FEE_RATE), minFee: String(MIN_FEE.toFixed(2)),
    expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
  }));
  const q = evs.map(simplify).find((x) => x.name === 'Quote');
  return { quote: q };
}

async function acceptQuote({ quoteCid, amount }) {
  const list = await acs('sender');
  const amt = Number(amount);
  const hs = holdings(list, 'sender', 'USD').filter((h) => Number(h.args.amount) >= amt).sort((a, b) => Number(a.args.amount) - Number(b.args.amount));
  if (!hs.length) throw new Error('Not enough USD in one holding. Use "Set up demo data" or send a smaller amount.');
  const evs = await submit('sender', exercise('Remit.Quote:Quote', quoteCid, 'AcceptQuote', {
    recipient: parties.recipient, regulator: parties.regulator, sendAmount: dec(amt),
    holdingCid: hs[0].cid, settleBy: new Date(Date.now() + 86400000).toISOString(),
  }));
  const t = evs.map(simplify).find((x) => x.name === 'RemitTransfer');
  return { transfer: t };
}

async function settle({ transferCid }) {
  const provList = await acs('provider');
  const t = provList.find((c) => c.cid === transferCid);
  if (!t) throw new Error('Transfer not found');
  const need = Number(t.args.receiveAmount);
  const pay = holdings(provList, 'provider', t.args.toCurrency).filter((h) => Number(h.args.amount) >= need).sort((a, b) => Number(a.args.amount) - Number(b.args.amount))[0];
  if (!pay) throw new Error(`The provider has no ${t.args.toCurrency} funds large enough`);
  const kyc = provList.find((c) => c.name === 'KycAttestation' && c.args.subject === t.args.sender);
  if (!kyc) throw new Error('No identity check on file for this sender');
  const evs = await submit('provider', exercise('Remit.Transfer:RemitTransfer', transferCid, 'Settle', { attestationCid: kyc.cid, payoutCid: pay.cid }));
  return { receipt: evs.map(simplify).find((x) => x.name === 'Receipt') };
}

const reject = async ({ transferCid }) => { await submit('provider', exercise('Remit.Transfer:RemitTransfer', transferCid, 'Reject', {})); return {}; };
const cancel = async ({ transferCid }) => { await submit('sender', exercise('Remit.Transfer:RemitTransfer', transferCid, 'CancelAfterDeadline', {})); return {}; };

async function earnStart({ amount, apr, lockDays }) {
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error('Enter an amount');
  const list = await acs('sender');
  const hs = holdings(list, 'sender', 'USD').filter((h) => Number(h.args.amount) >= amt).sort((a, b) => Number(a.args.amount) - Number(b.args.amount));
  if (!hs.length) throw new Error('Not enough USD in one holding');
  let holdingCid = hs[0].cid;
  if (Number(hs[0].args.amount) !== amt) {
    const evs = (await submit('sender', exercise('Remit.Token:Holding', holdingCid, 'Split', { splitAmount: dec(amt) }))).map(simplify);
    holdingCid = evs.find((e) => Number(e.args.amount) === amt).cid;
  }
  const offerEv = (await submit('provider', create('Remit.Earn:StakeOffer', {
    provider: parties.provider, owner: parties.sender, currency: 'USD', apr: String(apr), lockDays: String(lockDays), minAmount: '1.0',
  }))).map(simplify).find((x) => x.name === 'StakeOffer');
  const stake = (await submit('sender', exercise('Remit.Earn:StakeOffer', offerEv.cid, 'StartStake', { holdingCid }))).map(simplify).find((x) => x.name === 'Stake');
  return { stake };
}
async function earnRedeem({ stakeCid }) {
  const provList = await acs('provider');
  const reserve = holdings(provList, 'provider', 'USD').sort((a, b) => Number(b.args.amount) - Number(a.args.amount))[0];
  if (!reserve) throw new Error('The provider has no USD reserve');
  await submit(['provider', 'sender'], exercise('Remit.Earn:Stake', stakeCid, 'Redeem', { reserveCid: reserve.cid }));
  return {};
}
const earnClaim = async ({ stakeCid }) => { await submit('sender', exercise('Remit.Earn:Stake', stakeCid, 'ClaimPrincipal', {})); return {}; };

// ---------- http ----------
const routes = {
  'GET /api/config': async () => ({ corridors: CORRIDORS, feeRate: FEE_RATE, minFee: MIN_FEE, roles: ROLES }),
  'POST /api/setup': setup,
  'GET /api/view': async (q) => { if (!ROLES.includes(q.role)) throw new Error('Unknown role'); return { role: q.role, contracts: await acs(q.role) }; },
  'GET /api/views': async () => { const out = {}; for (const r of ROLES) out[r] = await acs(r); return out; },
  'POST /api/quote': makeQuote,
  'POST /api/accept': acceptQuote,
  'POST /api/settle': settle,
  'POST /api/reject': reject,
  'POST /api/cancel': cancel,
  'POST /api/earn/start': earnStart,
  'POST /api/earn/redeem': earnRedeem,
  'POST /api/earn/claim': earnClaim,
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      let body = {};
      if (req.method === 'POST') {
        const chunks = []; for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString(); body = raw ? JSON.parse(raw) : {};
      }
      const out = await handler(req.method === 'GET' ? Object.fromEntries(url.searchParams) : body);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out));
    } catch (e) {
      console.error(`${req.method} ${url.pathname}:`, e.message);
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
});

init().then(() => server.listen(CFG.port, () => console.log(`Swiftline app on http://localhost:${CFG.port}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
