// Browser test of the design-faithful app. Usage: node test/ui.test.js [url]   (SHOTS=dir to save screenshots)
const { chromium } = require('playwright');
const url = process.argv[2] || 'http://localhost:8090';
const shots = process.env.SHOTS || '/tmp/shots';
require('fs').mkdirSync(shots, { recursive: true });
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 700, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/status of 400|fonts|TUNNEL/.test(m.text()) && errs.push(m.text()));
  const shot = (n) => p.screenshot({ path: `${shots}/${n}.png` });
  const text = () => p.textContent('#screen');
  await p.goto(url + '/#/Welcome'); await p.waitForSelector('text=Send money to family'); await shot('1-welcome');
  await p.click('text=Continue'); await p.waitForSelector('text=You have', { timeout: 15000 }); await p.waitForTimeout(500);
  let t = await text(); ok(/1,200\.00/.test(t), 'home shows live balance 1,200.00'); await shot('2-home');
  await p.goto(url + '/#/Wallet'); await p.waitForSelector('text=Your currencies'); await p.waitForTimeout(500); await shot('3-wallet');
  await p.goto(url + '/#/Send'); await p.waitForSelector('#amt'); await p.waitForTimeout(500);
  ok(/Available: 1,200\.00 USD/.test(await text()), 'send shows available balance');
  await p.fill('#amt', '500'); ok(/41,251\.00/.test(await text()), 'send preview 41,251.00'); await shot('4-send');
  await p.click('text=Continue'); await p.waitForSelector('text=How will Ravi get it?'); await shot('5-cashout');
  await p.click('text=Continue'); await p.waitForSelector('text=Review transfer');
  ok(/41,251\.00 INR/.test(await text()) && /3\.00 USD/.test(await text()), 'review numbers'); await shot('6-review');
  await p.click('text=Confirm and send'); await p.waitForSelector('text=Transfer status');
  await p.waitForSelector('text=In progress'); await shot('7-track-progress');
  await p.waitForSelector('text=Delivered', { timeout: 15000 }); await shot('8-track-delivered');
  ok(/Ravi received 41,251\.00 INR/.test(await text()), 'track shows delivered');
  await p.goto(url + '/#/Receipt'); await p.waitForSelector('text=Your receipt'); await p.waitForTimeout(600); t = await text();
  ok(/41,251\.00 INR/.test(t) && /SW-/.test(t), 'receipt live data'); await shot('9-receipt');
  await p.goto(url + '/#/Earn'); await p.waitForSelector('text=Earn interest'); await p.waitForTimeout(500);
  await p.click('text=100.00 USD'); await p.click('text=Start earning on 100.00 USD'); await p.waitForSelector('text=You have', { timeout: 15000 }); await p.waitForTimeout(600);
  ok(/100\.00 USD is earning interest/.test(await text()), 'home shows 100 USD earning'); await shot('10-home-earning');
  await p.goto(url + '/#/Earn'); await p.waitForTimeout(600); await shot('11-earn');
  await p.goto(url + '/#/Regulator'); await p.waitForSelector('text=Transfer oversight'); await p.waitForTimeout(600);
  ok(/Settled/.test(await text()), 'regulator lists settled transfer'); await shot('12-regulator');
  for (const n of ['Recurring', 'Alerts', 'Request']) { await p.goto(url + '/#/' + n); await p.waitForTimeout(400); ok((await text()).length > 50, n + ' design screen renders'); }
  await p.goto(url + '/#/'); await p.waitForTimeout(500); ok((await text()).includes('Swiftline'), 'brief page renders'); await shot('13-brief');
  ok(errs.length === 0, 'no browser errors ' + errs.join(' | '));
  await b.close();
})();
