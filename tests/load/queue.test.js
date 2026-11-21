// Offline queue of the REAL supervisor.html (+ REAL login.html) against the emulator (REAL server code, FICTIONAL data).
// SAFETY: all Google traffic is answered locally; every other outside request is blocked and counted (must stay 0).
// Run: node tests/load/queue.test.js      (about 8 minutes)
const os = require('os'), path = require('path'), fs = require('fs');
const { startServers } = require('./lib/servers'); const B = require('./lib/browser');
const { chk, done } = require('./lib/report')('queue');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms, step) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(step || 500); } return !!(await fn()); };
const bus1 = k => String(1001 + 8 * k);              // students of bus 1 (sup1 and sup9)
const busId = (b, k) => String(1000 + b + 8 * k);    // students of bus b
(async () => {
  const srv = await startServers({ seed: { students: 400, supervisors: 9 } });
  const phones = [];
  const mk = async (fault, profile) => { const c = await B.phone(srv, fault, profile); phones.push(c); return c; };
  const rowsBy = (id, user) => srv.scans().filter(r => String(r[1]) === id && r[2] === 'board' && (!user || r[4] === user)).length;
  const nameOf = id => (srv.s.book.Bus.rows.find(r => r[3] === id) || [])[1];

  // ---- Q1 unstable network: offline flips + 40% lost answers + 30% server errors ----
  let fault = {}; let c = await mk(fault); let p = await B.login(srv, c, 'sup1');
  const q1 = Array.from({ length: 10 }, (_, k) => bus1(k));
  fault.loseAnswer = j => j.action === 'scan' && Math.random() < 0.4; fault.serverError = j => j.action === 'scan' && Math.random() < 0.3;
  for (let i = 0; i < q1.length; i++) { if (i % 3 === 0) await c.setOffline(true); await B.scan(p, q1[i]); if (i % 3 === 2) { await c.setOffline(false); await sleep(800); } }
  await c.setOffline(false); fault.loseAnswer = null; fault.serverError = null;
  await waitFor(async () => (await B.queueLen(p)) === 0, 150000, 2000);
  chk(q1.every(id => rowsBy(id) === 1), 'Q1 unstable network (offline flips, 40% lost answers, 30% server errors): 10/10 recorded exactly once');

  // ---- Q2 page closed with records waiting, supervisor comes back later ----
  await c.setOffline(true); for (const k of [10, 11]) await B.scan(p, bus1(k)); await p.close(); await c.setOffline(false);
  p = await B.open(srv, c); if (/login\.html/.test(p.url())) p = await B.login(srv, c, 'sup1');
  await waitFor(() => rowsBy(bus1(10)) && rowsBy(bus1(11)), 20000);
  chk(rowsBy(bus1(10)) === 1 && rowsBy(bus1(11)) === 1, 'Q2 page closed with 2 waiting, reopened later (log in again): both recorded once');

  // ---- Q3 phone/browser restart (persistent storage) ----
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-phone-'));
  let f3 = {}; let c3 = await B.phone(srv, f3, prof); let p3 = await B.login(srv, c3, 'sup1');
  await c3.setOffline(true); for (const k of [12, 13, 14]) await B.scan(p3, bus1(k)); const waiting = await B.queueLen(p3); await c3.close();
  c3 = await mk(f3, prof); p3 = await B.login(srv, c3, 'sup1'); await waitFor(() => [12, 13, 14].every(k => rowsBy(bus1(k)) === 1), 20000);
  chk(waiting >= 3 && [12, 13, 14].every(k => rowsBy(bus1(k)) === 1), `Q3 browser/phone restart with ${waiting} waiting, log in again: 3/3 recorded once`);

  // ---- Q4 page killed while the request was on its way (server applied it, answer never arrived) ----
  fault.loseAnswer = j => j.action === 'scan' && j.studentId === bus1(15); await B.scan(p, bus1(15)); await sleep(600); await p.close(); fault.loseAnswer = null;
  p = await B.open(srv, c); if (/login\.html/.test(p.url())) p = await B.login(srv, c, 'sup1'); await waitFor(() => rowsBy(bus1(15)), 20000);
  chk(rowsBy(bus1(15)) === 1, 'Q4 page killed with the request in flight: recorded exactly once after reopening');

  // ---- Q5 logout with a record waiting, then log in again ----
  fault.serverError = j => j.action === 'scan' && j.studentId === bus1(16); await B.scan(p, bus1(16)); await sleep(1500);
  await p.click('#logoutBtn'); await sleep(800); fault.serverError = null; p = await B.login(srv, c, 'sup1'); await waitFor(() => rowsBy(bus1(16)), 30000);
  chk(rowsBy(bus1(16)) === 1, 'Q5 logout with 1 waiting (supervisor confirms the warning), log in again: recorded once');

  // ---- Q6/Q7 the server keeps refusing ONE student, then recovers ----
  const X = bus1(17); let failing = true; fault.serverError = j => failing && j.action === 'scan' && j.studentId === X;
  await B.scan(p, X); for (const k of [18, 19, 20]) { await B.scan(p, bus1(k)); await sleep(1500); }
  await waitFor(() => [18, 19, 20].every(k => rowsBy(bus1(k)) === 1), 90000, 1000);
  const others = [18, 19, 20].every(k => rowsBy(bus1(k)) === 1);
  const warnBefore = await p.evaluate(n => { const e = document.getElementById('failbox'); return !!e && e.textContent.includes(n); }, nameOf(X));
  await B.scan(p, bus1(21)); await sleep(500);
  const warnAfter = await p.evaluate(n => { const e = document.getElementById('failbox'); return !!e && e.textContent.includes(n); }, nameOf(X));
  chk(others, 'Q6a [C5] the records queued BEHIND the failing one are not blocked by it');
  chk(warnBefore && warnAfter, 'Q7 [C5] a record that keeps failing is shown clearly (name in a persistent warning that stays after the next scan)');
  failing = false; await waitFor(() => rowsBy(X) === 1, 120000, 2000);
  chk(rowsBy(X) === 1, 'Q6 [C5] the server refused the same student many times, then recovered: the record was NOT given up and is recorded once');
  await waitFor(async () => (await B.queueLen(p)) === 0, 60000, 1000);

  // ---- Q8 slow server: a roster refresh must not show queued students as "not boarded" ----
  fault.delayMs = j => j.action === 'scan' ? 8000 : 0; const q8 = [22, 23, 24, 25, 26, 27].map(bus1);
  for (const id of q8) await B.scan(p, id);
  await p.evaluate(() => refreshRoster(true).then(render)); await sleep(500);
  const shown = await p.evaluate(ids => ({ q: queue.length, ok: ids.filter(id => (st.roster.students.find(s => s.id === id) || {}).state === 'boarded') }), q8);
  chk(shown.q > 0 && shown.ok.length === q8.length, `Q8 [C6] roster refreshed while ${shown.q} are still queued: ${shown.ok.length}/6 still shown as boarded (⏳)`);
  fault.delayMs = null; await waitFor(() => q8.every(id => rowsBy(id) === 1), 90000, 1000);
  chk(q8.every(id => rowsBy(id) === 1), 'Q8b all 6 recorded once afterwards');
  fault.delayMs = j => j.action === 'scan' ? 8000 : 0; const U8 = bus1(36); await B.scan(p, U8); await sleep(9500);
  await p.evaluate(id => { st.last = { id, name: 'x', canUndo: true, at: Date.now() }; undo(); }, U8);
  await p.evaluate(() => refreshRoster(true).then(render)); await sleep(300);
  const u8 = await p.evaluate(id => (st.roster.students.find(s => s.id === id) || {}).state, U8); fault.delayMs = null;
  await waitFor(async () => (await B.queueLen(p)) === 0, 60000, 1000);
  chk(u8 === 'none' && srv.scans().filter(r => String(r[1]) === U8).map(r => r[2]).join(',') === 'board,undo', 'Q8c [C6] an undo still waiting shows the student as NOT boarded after a refresh; server gets board then undo, in order');

  // ---- Q9 a connection that never answers must not freeze the queue ----
  let hung = false; fault.hang = j => { if (!hung && j.action === 'scan' && j.studentId === bus1(28)) { hung = true; return true; } return false; };
  await B.scan(p, bus1(28)); await B.scan(p, bus1(29)); fault.hang = null;
  await waitFor(() => rowsBy(bus1(28)) === 1 && rowsBy(bus1(29)) === 1, 75000, 1000);
  chk(rowsBy(bus1(28)) === 1 && rowsBy(bus1(29)) === 1, 'Q9 [C7] the first request hangs forever: the queue recovers by itself and both are recorded once (within 75 s)');

  // ---- Q10 the supervisor moves to ANOTHER device ----
  const cA = await mk({}); const pA = await B.login(srv, cA, 'sup1');
  const a = [30, 31, 32].map(bus1); await cA.setOffline(true); await B.scan(pA, a[0]); await B.scan(pA, a[1]);
  const cB = await mk({}); const pB = await B.login(srv, cB, 'sup1'); const bSeesA0 = await pB.evaluate(id => (st.roster.students.find(s => s.id === id) || {}).state, a[0]);
  await B.scan(pB, a[1]); await B.scan(pB, a[2]); await waitFor(() => rowsBy(a[1]) && rowsBy(a[2]), 20000);
  await cA.setOffline(false); await waitFor(() => rowsBy(a[0]) === 1, 40000, 1000); await waitFor(async () => (await B.queueLen(pA)) === 0, 30000);
  const aFail = await pA.evaluate(() => { const e = document.getElementById('failbox'); return e ? e.textContent : ''; });
  chk(a.every(id => rowsBy(id) === 1) && !aFail, `Q10 other device: phone A had 2 waiting, phone B recorded 1 of them again + 1 new, A reconnects: 3/3 recorded once, no false failure on A (B saw A's first record as "${bSeesA0}" until A synced — expected limitation)`);

  // ---- Q11 two supervisors of the same bus record the SAME student while offline, both reconnect together ----
  const Y = bus1(33); const c1b = await mk({}); const p1b = await B.login(srv, c1b, 'sup1'); const c9 = await mk({}); const p9 = await B.login(srv, c9, 'sup9');
  await c1b.setOffline(true); await c9.setOffline(true); await B.scan(p1b, Y); await B.scan(p9, Y);
  await Promise.all([c1b.setOffline(false), c9.setOffline(false)]); await waitFor(async () => (await B.queueLen(p1b)) + (await B.queueLen(p9)) === 0, 40000, 1000);
  await p1b.evaluate(() => refreshRoster(true).then(render)); await p9.evaluate(() => refreshRoster(true).then(render)); await sleep(800);
  const both = await Promise.all([p1b, p9].map(x => x.evaluate(id => (st.roster.students.find(s => s.id === id) || {}).state, Y)));
  chk(rowsBy(Y) === 1 && both.every(v => v === 'boarded'), 'Q11 same student recorded by 2 supervisors while offline, both reconnect together: 1 row, both screens show him boarded');

  // ---- Q12 the network comes back for 8 supervisors at the same moment ----
  const fleet = []; for (let b = 1; b <= 8; b++) { const cx = await mk({}); const px = await B.login(srv, cx, 'sup' + b); fleet.push({ cx, px, ids: Array.from({ length: 6 }, (_, k) => busId(b, 40 + k)) }); }
  await Promise.all(fleet.map(f => f.cx.setOffline(true)));
  for (const f of fleet) for (const id of f.ids) await B.scan(f.px, id);
  const t12 = Date.now(); await Promise.all(fleet.map(f => f.cx.setOffline(false)));
  await waitFor(() => fleet.every(f => f.ids.every(id => rowsBy(id) === 1)), 180000, 1000); const drain = Math.round((Date.now() - t12) / 1000);
  const all12 = fleet.flatMap(f => f.ids);
  chk(all12.every(id => rowsBy(id) === 1), `Q12 network returns for 8 supervisors at once (48 waiting): 48/48 recorded exactly once (all in ${drain} s)`);
  for (const f of fleet) await f.cx.close();

  // ---- Q13 queues are isolated per user on a SHARED phone, and hold no token ----
  const fz = {}; const cz = await mk(fz); let pz = await B.login(srv, cz, 'sup1'); const P = [34, 35].map(bus1);
  fz.serverError = j => j.action === 'scan' && P.includes(j.studentId); for (const id of P) await B.scan(pz, id); await sleep(1000);
  const tokenInStore = await pz.evaluate(() => { const t = sessionStorage.getItem('mukhayyam_token'); return Object.keys(localStorage).some(k => (localStorage.getItem(k) || '').includes(t)); });
  await pz.click('#logoutBtn'); await sleep(800); fz.serverError = null;
  pz = await B.login(srv, cz, 'sup2'); await sleep(5000);
  const leak = P.reduce((n, id) => n + srv.scans().filter(r => String(r[1]) === id).length, 0), q2len = await B.queueLen(pz);
  await pz.click('#logoutBtn'); await sleep(800); pz = await B.login(srv, cz, 'sup1'); await waitFor(() => P.every(id => rowsBy(id, 'sup1') === 1), 30000);
  chk(leak === 0 && q2len === 0 && P.every(id => rowsBy(id, 'sup1') === 1) && !tokenInStore, `Q13 shared phone: sup1's 2 waiting records were NOT sent by sup2 (leak=${leak}, sup2 queue=${q2len}); sent under sup1 when he logged back in; no token stored with the queue`);

  // ---- Q16 records saved by the PREVIOUS version (queue stored under the display name) are moved, not lost ----
  const c16 = await mk({}); let p16 = await B.login(srv, c16, 'sup3'); const Z = busId(3, 30);
  await p16.evaluate(z => { const k = 'mk_sup_' + sessionStorage.getItem('mukhayyam_fullName') + 'queue'; localStorage.setItem(k, JSON.stringify([{ kind: 'scan', body: { clientId: 'old-version-1', action: 'scan', op: 'board', studentId: z, method: 'qr' } }])); }, Z);
  await p16.reload(); await waitFor(() => rowsBy(Z, 'sup3') === 1, 20000);
  const oldLeft = await p16.evaluate(() => localStorage.getItem('mk_sup_' + sessionStorage.getItem('mukhayyam_fullName') + 'queue'));
  chk(rowsBy(Z, 'sup3') === 1 && !oldLeft, 'Q16 [C5] a record left by the previous version (queue under the display name) is moved to the new queue and sent once');

  // ---- Q14 safety ----
  const escaped = phones.reduce((n, x) => n + ((x.__stats && x.__stats.escaped) || 0), 0);
  chk(escaped === 0, `Q14 safety: requests that tried to leave the machine = ${escaped}; every Google request was answered by the local emulator`);
  const cids = srv.scans().slice(1).map(r => r[6]).filter(Boolean); chk(new Set(cids).size === cids.length && srv.scans().slice(1).every(r => r[2] !== 'board' || srv.scans().filter(x => x[1] === r[1] && x[2] === 'board').length === 1), 'Q15 whole log: no clientId twice, no student boarded twice');
  for (const x of phones) await x.close().catch(() => {}); await B.closeAll(); await srv.close(); done();
})().catch(e => { console.error(e); process.exit(2); });
