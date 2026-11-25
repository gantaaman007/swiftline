// Stand-in for the Canton JSON Ledger API + Keycloak, for testing the app server and UI offline.
// It mimics the response shapes verified against a real LocalNet and re-implements the Daml
// choice logic. It does NOT prove the real contracts work; the Daml tests and live scripts do that.
const http = require('http');
const PORT = Number(process.env.MOCK_PORT || 3975);
const PKG = 'deadbeef00';
let n = 0, offset = 0;
const parties = []; let contracts = []; // {cid, tpl, args, sig:[], obs:[], active}
const now = () => Date.now();
const d2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
const dstr = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

function make(tpl, args, sig, obs) { const c = { cid: `00${(++n).toString(16).padStart(6, '0')}${tpl.length}`, tpl, args, sig, obs, active: true }; contracts.push(c); return c; }
const get = (cid) => { const c = contracts.find((x) => x.cid === cid && x.active); if (!c) throw new Error('CONTRACT_NOT_FOUND ' + cid); return c; };
const holding = (a) => { a.viewers = a.viewers || []; if (!(Number(a.amount) > 0)) throw new Error('ensure amount > 0'); return make('Holding', { ...a, amount: dstr(Number(a.amount)) }, [a.issuer], [a.owner, ...a.viewers]); };
const created = [];
const track = (c) => { created.push(c); return c; };

function need(actAs, p, why) { if (!actAs.includes(p)) throw new Error('DAML_AUTHORIZATION_ERROR ' + why); }
function exerciseHolding(actAs, c, choice, a) {
  need(actAs, c.args.owner, 'controller owner'); c.active = false;
  const h = c.args;
  if (choice === 'MoveTo') return track(holding({ ...h, owner: a.newOwner, viewers: [] }));
  if (choice === 'Lock') return track(holding({ ...h, owner: a.newOwner, viewers: [a.viewer] }));
  if (choice === 'Split') {
    const s = Number(a.splitAmount), amt = Number(h.amount);
    if (!(s > 0 && s < amt)) throw new Error('Split amount must be positive and smaller than the holding');
    return [track(holding({ ...h, amount: s })), track(holding({ ...h, amount: amt - s }))];
  }
}
// Daml sub-exercises are authorized by the contract's signatories, so inner calls act as everyone.
const ALL = () => parties;

function run(cmd, actAs) {
  if (cmd.CreateCommand) {
    const { templateId, createArguments: a } = cmd.CreateCommand; const t = templateId.split(':').pop();
    if (t === 'Holding') { need(actAs, a.issuer, 'issuer signs'); return [track(holding(a))]; }
    if (t === 'KycAttestation') { need(actAs, a.provider, 'provider signs'); return [track(make(t, a, [a.provider], [a.subject, a.regulator]))]; }
    if (t === 'Quote') { need(actAs, a.provider, 'provider signs'); return [track(make(t, a, [a.provider], [a.sender]))]; }
    if (t === 'StakeOffer') { need(actAs, a.provider, 'provider signs'); return [track(make(t, a, [a.provider], [a.owner]))]; }
    throw new Error('unknown template ' + t);
  }
  const { templateId, contractId, choice, choiceArgument: a } = cmd.ExerciseCommand; const t = templateId.split(':').pop();
  const c = get(contractId);
  if (c.tpl !== t) throw new Error('template mismatch');
  const x = c.args;
  if (t === 'Holding') { exerciseHolding(actAs, c, choice, a); return created; }
  if (t === 'Quote' && choice === 'AcceptQuote') {
    need(actAs, x.sender, 'controller sender'); c.active = false;
    if (now() > new Date(x.expiresAt).getTime()) throw new Error('This quote has expired');
    const amt = Number(a.sendAmount); let h = get(a.holdingCid);
    if (h.args.owner !== x.sender) throw new Error('That money does not belong to the sender');
    if (h.args.currency !== x.fromCurrency) throw new Error('That money is in a different currency');
    if (Number(h.args.amount) < amt) throw new Error('Not enough money to send');
    const fee = d2(Math.max(Number(x.minFee), amt * Number(x.feeRate)));
    if (!(amt > fee)) throw new Error('Amount must be larger than the fee');
    const recv = d2((amt - fee) * Number(x.rate));
    let lock = h.cid;
    if (Number(h.args.amount) !== amt) lock = exerciseHolding([h.args.owner], h, 'Split', { splitAmount: dstr(amt) })[0].cid;
    const esc = exerciseHolding([x.sender], get(lock), 'Lock', { newOwner: x.provider, viewer: x.sender });
    const tr = make('RemitTransfer', { provider: x.provider, sender: x.sender, recipient: a.recipient, regulator: a.regulator, fromCurrency: x.fromCurrency, toCurrency: x.toCurrency,
      sendAmount: dstr(amt), fee: dstr(fee), receiveAmount: dstr(recv), rate: x.rate, escrowCid: esc.cid, settleBy: a.settleBy }, [x.provider, x.sender], [a.recipient, a.regulator]);
    return [track(tr)];
  }
  if (t === 'RemitTransfer') {
    if (choice === 'Settle') {
      need(actAs, x.provider, 'controller provider');
      const kyc = get(a.attestationCid);
      if (kyc.args.subject !== x.sender) throw new Error('Attestation is for someone else');
      if (now() > new Date(kyc.args.validUntil).getTime()) throw new Error('Attestation expired');
      if (Number(x.sendAmount) > Number(kyc.args.perTransferLimit)) throw new Error('Transfer is above the allowed limit');
      const p = get(a.payoutCid); if (p.args.currency !== x.toCurrency) throw new Error('wrong payout currency');
      if (Number(p.args.amount) < Number(x.receiveAmount)) throw new Error('Not enough payout funds');
      c.active = false;
      let pay = p.cid; if (Number(p.args.amount) !== Number(x.receiveAmount)) pay = exerciseHolding([p.args.owner], p, 'Split', { splitAmount: x.receiveAmount })[0].cid;
      exerciseHolding([x.provider], get(pay), 'MoveTo', { newOwner: x.recipient });
      exerciseHolding([x.provider], get(x.escrowCid), 'MoveTo', { newOwner: x.provider });
      track(make('Receipt', { provider: x.provider, sender: x.sender, recipient: x.recipient, regulator: x.regulator, fromCurrency: x.fromCurrency, toCurrency: x.toCurrency, sendAmount: x.sendAmount, fee: x.fee, receiveAmount: x.receiveAmount, rate: x.rate, settledAt: new Date().toISOString() }, [x.provider, x.sender], [x.recipient, x.regulator]));
      return created;
    }
    if (choice === 'Reject') { need(actAs, x.provider, 'controller provider'); c.active = false; exerciseHolding([x.provider], get(x.escrowCid), 'MoveTo', { newOwner: x.sender }); return created; }
    if (choice === 'CancelAfterDeadline') {
      need(actAs, x.sender, 'controller sender');
      if (!(now() > new Date(x.settleBy).getTime())) throw new Error('The provider still has time to settle');
      c.active = false; exerciseHolding([x.provider], get(x.escrowCid), 'MoveTo', { newOwner: x.sender }); return created;
    }
  }
  if (t === 'StakeOffer' && choice === 'StartStake') {
    need(actAs, x.owner, 'controller owner'); c.active = false;
    const h = get(a.holdingCid);
    if (h.args.owner !== x.owner || h.args.currency !== x.currency) throw new Error('That money is not yours / wrong currency');
    if (Number(h.args.amount) < Number(x.minAmount)) throw new Error('Below the minimum amount');
    const locked = exerciseHolding([x.owner], h, 'Lock', { newOwner: x.provider, viewer: x.owner });
    return [track(make('Stake', { provider: x.provider, owner: x.owner, currency: x.currency, principal: h.args.amount, apr: x.apr, startedAt: new Date().toISOString(), maturesAt: new Date(now() + Number(x.lockDays) * 86400000).toISOString(), lockedCid: locked.cid }, [x.provider, x.owner], []))];
  }
  if (t === 'Stake') {
    if (choice === 'Redeem') {
      need(actAs, x.provider, 'controller provider'); c.active = false;
      const end = Math.min(now(), new Date(x.maturesAt).getTime()); const micros = (end - new Date(x.startedAt).getTime()) * 1000;
      const interest = d2(Number(x.principal) * Number(x.apr) * micros / (365 * 86400000000));
      exerciseHolding([x.provider], get(x.lockedCid), 'MoveTo', { newOwner: x.owner });
      if (interest > 0) {
        const r = get(a.reserveCid); if (Number(r.args.amount) < interest) throw new Error('reserve too small');
        let pay = r.cid; if (Number(r.args.amount) !== interest) pay = exerciseHolding([x.provider], r, 'Split', { splitAmount: dstr(interest) })[0].cid;
        exerciseHolding([x.provider], get(pay), 'MoveTo', { newOwner: x.owner });
      }
      return created;
    }
    if (choice === 'ClaimPrincipal') {
      need(actAs, x.owner, 'controller owner');
      if (now() < new Date(x.maturesAt).getTime()) throw new Error('Not matured yet');
      c.active = false; exerciseHolding([x.provider], get(x.lockedCid), 'MoveTo', { newOwner: x.owner }); return created;
    }
  }
  throw new Error('unsupported choice ' + choice);
}

const ev = (c) => ({ contractId: c.cid, templateId: `${PKG}:Remit.${c.tpl === 'Holding' ? 'Token' : c.tpl === 'KycAttestation' ? 'Compliance' : c.tpl === 'Quote' ? 'Quote' : c.tpl === 'StakeOffer' || c.tpl === 'Stake' ? 'Earn' : 'Transfer'}:${c.tpl}`, packageName: 'remittance', createArgument: c.args, witnessParties: [...new Set([...c.sig, ...c.obs])] });
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c); const raw = Buffer.concat(chunks).toString();
  const body = raw && raw.startsWith('{') ? JSON.parse(raw) : {}; const url = req.url;
  if (url.includes('openid-connect/token')) return json(res, 200, { access_token: 'mock-token', expires_in: 300 });
  if (req.headers.authorization !== 'Bearer mock-token') return json(res, 401, { cause: 'no token' });
  try {
    if (url === '/v2/authenticated-user') return json(res, 200, { user: { id: 'admin-user' } });
    if (url === '/v2/parties' && req.method === 'GET') return json(res, 200, { partyDetails: parties.map((p) => ({ party: p })) });
    if (url === '/v2/parties') { const p = `${body.partyIdHint}::1220abcd`; parties.push(p); return json(res, 200, { partyDetails: { party: p } }); }
    if (url.startsWith('/v2/users/')) return json(res, 200, {});
    if (url === '/v2/state/ledger-end') return json(res, 200, { offset });
    if (url === '/v2/state/active-contracts') {
      if (!body.eventFormat) return json(res, 400, { cause: 'DEPRECATED_API_DISABLED' });
      const p = Object.keys(body.eventFormat.filtersByParty)[0];
      return json(res, 200, contracts.filter((c) => c.active && (c.sig.includes(p) || c.obs.includes(p))).map((c) => ({ contractEntry: { JsActiveContract: { createdEvent: ev(c) } } })));
    }
    if (url === '/v2/commands/submit-and-wait-for-transaction') {
      if (!body.commands || !body.commands.commands) return json(res, 400, { cause: "Missing required field at 'commands.commands'" });
      const snapshot = JSON.stringify(contracts); created.length = 0;
      try {
        run(body.commands.commands[0], body.commands.actAs);
      } catch (e) { contracts = JSON.parse(snapshot); throw e; }
      offset++;
      const vis = created.filter((c) => c.sig.concat(c.obs).some((p) => body.commands.actAs.includes(p)));
      return json(res, 200, { transaction: { events: vis.map((c) => ({ CreatedEvent: ev(c) })) } });
    }
    json(res, 404, { cause: 'no route ' + url });
  } catch (e) { json(res, 400, { cause: e.message }); }
}).listen(PORT, () => console.log('Mock ledger on ' + PORT));
