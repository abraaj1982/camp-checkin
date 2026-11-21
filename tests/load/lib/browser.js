// Browser helpers. SAFETY: every request to script.google.com is answered by the LOCAL emulator,
// every other non-local request is blocked, and `escaped` counts any attempt (tests assert it stays 0).
const { chromium } = require('playwright');
function makeRouter(srv, fault) {
  const stats = { escaped: 0, google: 0 };
  async function route(r) {
    const url = r.request().url();
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) return r.continue();
    if (!url.startsWith('https://script.google.com/')) { if (!/fonts\.|cdnjs/.test(url)) stats.escaped++; return r.abort(); }
    stats.google++;
    const body = r.request().postData() || '{}'; let j = {}; try { j = JSON.parse(body); } catch (e) {}
    const reply = t => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: t });
    if (fault.hang && fault.hang(j)) return; // never answers (a stuck connection)
    if (fault.serverError && fault.serverError(j)) return reply('{"success":false,"error":"Server error"}');
    if (fault.delayMs && fault.delayMs(j)) await new Promise(x => setTimeout(x, fault.delayMs(j)));
    let t; try { t = await (await fetch(srv.apiUrl, { method: 'POST', body })).text(); } catch (e) { return r.abort(); }
    if (fault.loseAnswer && fault.loseAnswer(j)) return r.abort('connectionreset'); // applied on the server, answer lost
    return reply(t);
  }
  return { route, stats };
}
let shared = null;
async function phone(srv, fault, profileDir) {
  const router = makeRouter(srv, fault || {});
  if (!profileDir && !shared) shared = await chromium.launch();
  const c = profileDir ? await chromium.launchPersistentContext(profileDir, { viewport: { width: 390, height: 844 } }) : await shared.newContext({ viewport: { width: 390, height: 844 } });
  await c.route('**/*', router.route);
  await c.addInitScript(() => { try { sessionStorage.setItem('mk_loc_off', '1'); } catch (e) {} });
  c.__stats = router.stats;
  return c;
}
const HANDLED = new WeakSet();
function onDialogs(p) { if (HANDLED.has(p)) return; HANDLED.add(p); p.on('dialog', d => d.accept().catch(() => {})); }
async function login(srv, c, username, password) {
  const p = c.pages()[0] || await c.newPage(); onDialogs(p);
  await p.goto(srv.webUrl + '/login.html'); await p.fill('#username', username); await p.fill('#password', password || 'load-test-1');
  await p.press('#password', 'Enter'); await p.waitForURL(/supervisor\.html/, { timeout: 15000 }); await p.waitForTimeout(2000); return p;
}
async function open(srv, c) { const p = await c.newPage(); onDialogs(p); await p.goto(srv.webUrl + '/supervisor.html'); await p.waitForTimeout(1500); return p; }
async function scan(p, id) { await p.evaluate(id => window.__onScanText(id), id); await p.waitForTimeout(200); await p.click('button[onclick="board()"]'); await p.waitForTimeout(200); }
const queueLen = p => p.evaluate(() => queue.length);
async function closeAll() { if (shared) { await shared.close(); shared = null; } }
module.exports = { closeAll, phone, login, open, scan, queueLen, onDialogs };
