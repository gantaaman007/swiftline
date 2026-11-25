// Browser test against the running app (mock or real). Usage: node test/ui.test.js [url]
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://localhost:8090';
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1000, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/status of 400/.test(m.text()) && errs.push(m.text()));
  await p.goto(url + '/console.html'); await p.waitForSelector('#setup');
  await p.click('#setup'); await p.waitForTimeout(800);
  // 1 send & settle
  await p.fill('#amt', '500'); await p.selectOption('#cur', 'INR'); await p.click('#go');
  await p.waitForSelector('#recv'); ok((await p.textContent('#recv')).includes('41,251.00 INR'), 'review shows 41,251.00 INR');
  await p.click('#confirm'); await p.waitForSelector('#rcpt');
  ok((await p.textContent('#rcpt')).includes('41,251.00'), 'receipt shows 41,251.00');
  await p.screenshot({ path: process.env.SHOTS ? process.env.SHOTS + '/receipt.png' : '/tmp/receipt.png' });
  // 2 hold then reject
  await p.click('#again'); await p.fill('#amt', '100'); await p.check('#hold'); await p.click('#go');
  await p.waitForSelector('#confirm'); await p.click('#confirm'); await p.waitForSelector('text=Transfer waiting');
  await p.click('#nav-track'); await p.waitForSelector('button[data-a=reject]');
  await p.click('button[data-a=reject]'); await p.waitForTimeout(800);
  ok((await p.locator('button[data-a=reject]').count()) === 0, 'reject clears the escrow list');
  // 3 cancel too early should show error
  await p.click('#nav-send'); await p.fill('#amt', '50'); await p.check('#hold'); await p.click('#go');
  await p.waitForSelector('#confirm'); await p.click('#confirm'); await p.click('#nav-track');
  await p.waitForSelector('button[data-a=cancel]'); await p.click('button[data-a=cancel]'); await p.waitForTimeout(800);
  ok((await p.textContent('#err')).includes('still has time'), 'early cancel shows an error');
  await p.click('button[data-a=reject]'); await p.waitForTimeout(500);
  // 4 earn
  await p.click('#nav-earn'); await p.fill('#eamt', '100'); await p.click('#stake'); await p.waitForSelector('button[data-a="earn/redeem"]');
  await p.waitForTimeout(2500); await p.click('button[data-a="earn/redeem"]'); await p.waitForTimeout(800);
  ok((await p.locator('button[data-a="earn/redeem"]').count()) === 0, 'redeem closes the stake');
  await p.click('#nav-earn'); await p.waitForTimeout(300);
  // 5 privacy
  await p.click('#nav-privacy'); await p.click('.tabs button[data-r=outsider]'); await p.waitForTimeout(300);
  ok((await p.textContent('#count')) === '0', 'outsider sees 0 contracts');
  await p.click('.tabs button[data-r=recipient]'); await p.waitForTimeout(300);
  const txt = await p.textContent('#view');
  ok(!/KycAttestation|Quote|Stake/.test(txt) && /Receipt/.test(txt), 'recipient sees receipts but no KYC, quote or stake');
  await p.screenshot({ path: process.env.SHOTS ? process.env.SHOTS + '/privacy.png' : '/tmp/privacy.png' });
  ok(errs.length === 0, 'no browser errors ' + errs.join('|'));
  await b.close();
})();
