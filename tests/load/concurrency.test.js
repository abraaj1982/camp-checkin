// Concurrency, duplicates, permissions and session safety — REAL server code, REAL parallel executions (emulator), FICTIONAL data.
// Run: node tests/load/concurrency.test.js
const { seed } = require('./lib/seed'); const { createEmu } = require('./lib/emu'); const { vm } = require('./lib/gasctx');
const { chk, done } = require('./lib/report')('concurrency');
const SMALL = { open: 30, readBase: 20, readPerKCell: 2, append: 40, set: 30, getRange: 10, cache: 2, props: 2, lock: 2 };
const REAL = undefined; // default calibrated latencies (wider race windows)
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  // ---------------- C: writes, duplicates, permissions ----------------
  let s = seed({ supervisors: 9 }); let emu = createEmu(s, { slots: 30, netOverheadMs: 0, lat: SMALL });
  const call = b => emu.call(b).then(x => x.out);
  const boards = id => s.book.Scans.rows.filter(r => String(r[1]) === id && r[2] === 'board').length;
  const T = s.tokens;
  let r = await Promise.all(Array.from({ length: 10 }, () => call({ action: 'scan', op: 'board', token: T.sup3, studentId: '1003', clientId: 'same-1', method: 'qr' })));
  chk(boards('1003') === 1 && r.every(x => x.success), 'C1 same request x10 at the same instant -> 1 row, all answered success');
  const ids = Array.from({ length: 20 }, (_, i) => String(1004 + i * 8));
  const pairs = await Promise.all(ids.map(id => Promise.all([call({ action: 'scan', op: 'board', token: T.all1, studentId: id, clientId: 'a-' + id, method: 'qr' }), call({ action: 'scan', op: 'board', token: T.all2, studentId: id, clientId: 'b-' + id, method: 'qr' })])));
  chk(pairs.every(p => p.filter(x => x.success).length === 1 && p.filter(x => x.code === 'DUPLICATE').length === 1) && ids.every(id => boards(id) === 1), 'C2 two users board the SAME student at the same instant (x20) -> 1 row, the other told DUPLICATE');
  const ids3 = Array.from({ length: 10 }, (_, i) => String(1005 + i * 8));
  const p3 = await Promise.all(ids3.map(id => Promise.all([call({ action: 'receptionArrive', token: T.secr, studentId: id, guardian: 'ولي أمر تجريبي', relation: 'father', clientId: 'g-' + id }), call({ action: 'scan', op: 'board', token: T.all1, studentId: id, clientId: 'c-' + id, method: 'qr' })])));
  chk(ids3.every(id => boards(id) === 1) && p3.every(p => p.filter(x => x.success).length === 1), 'C3 reception arrival vs bus scan of the same student at the same instant (x10) -> 1 row');
  const ids4 = Array.from({ length: 30 }, (_, i) => String(1006 + i * 8));
  const r4 = await Promise.all(ids4.map(id => call({ action: 'scan', op: 'board', token: T.all2, studentId: id, clientId: 'd-' + id, method: 'qr' })));
  chk(ids4.every(id => boards(id) === 1) && r4.every(x => x.success), 'C4 30 different students written at the same moment -> all recorded');
  const p5 = await Promise.all([call({ action: 'scan', op: 'board', token: T.sup1, studentId: '1002', clientId: 'x1', method: 'qr' }), call({ action: 'scan', op: 'board', token: T.secr, studentId: '1010', clientId: 'x2', method: 'qr' }), call({ action: 'scan', op: 'board', token: T.leader, studentId: '1010', clientId: 'x3', method: 'qr' }), call({ action: 'leaderAll', token: T.scout }), call({ action: 'medList', token: T.sup1 }), call({ action: 'createUser', token: T.leader, username: 'hack', password: 'abcdefgh1', fullName: 'x' })]);
  chk(p5[0].code === 'OTHER_BUS' && p5[1].code === 'FORBIDDEN' && p5[2].code === 'FORBIDDEN' && p5[3].code === 'FORBIDDEN' && p5[4].code === 'FORBIDDEN' && !p5[5].success, 'C5 permissions hold under concurrency (other bus, secretariat/leader scan, scout dashboard, supervisor medical, leader createUser)');
  const ro = await call({ action: 'roster', token: T.sup1 }), lk = await call({ action: 'lookup', token: T.sup1, q: '100' });
  chk(!/99990000/.test(JSON.stringify(ro) + JSON.stringify(lk)), 'C6 guardian phone never in roster/lookup');
  const cids = s.book.Scans.rows.slice(1).map(x => x[6]).filter(Boolean);
  chk(new Set(cids).size === cids.length, 'C7 integrity: no clientId applied twice (' + cids.length + ' rows)');
  await emu.close();

  // ---------------- S: last-activity / session safety ----------------
  s = seed({ supervisors: 9 }); emu = createEmu(s, { slots: 30, netOverheadMs: 0, lat: SMALL });
  let U = s.book.Users.rows, H = U[0]; const iL = H.indexOf('LastActivityAt'), iA = H.indexOf('Active');
  const row = u => U.find(x => x[0] === u); const old = new Date(Date.now() - 6 * 60e3); const flush = () => Object.keys(emu.cache).forEach(k => delete emu.cache[k]);
  const before = JSON.stringify(U.map(x => x.filter((_, j) => j !== iL)));
  row('sup2')[iL] = old; flush();
  const inflight = Array.from({ length: 20 }, () => emu.call({ action: 'roster', token: s.tokens.sup2 }));
  const rv = emu.call({ action: 'resetPassword', token: s.tokens.admin, targetUsername: 'sup2', newPassword: 'new-pass-123' });
  await Promise.all(inflight); const r1 = (await rv).out; const a1 = (await emu.call({ action: 'roster', token: s.tokens.sup2 })).out;
  chk(r1.success && a1.code === 'REVOKED', 'S1 password reset during 20 in-flight requests -> old token REVOKED afterwards');
  row('sup3')[iL] = old; flush();
  const inf2 = Array.from({ length: 20 }, () => emu.call({ action: 'roster', token: s.tokens.sup3 }));
  await emu.call({ action: 'setUserActive', token: s.tokens.admin, targetUsername: 'sup3', active: false }); await Promise.all(inf2);
  chk((await emu.call({ action: 'roster', token: s.tokens.sup3 })).out.code === 'ACCOUNT_DISABLED' && row('sup3')[iA] === false, 'S2 account disabled during 20 in-flight requests -> stays disabled');
  const longAgo = new Date(Date.now() - 3 * 3600e3); row('sup4')[iL] = longAgo; flush();
  const r3 = await Promise.all(Array.from({ length: 5 }, () => emu.call({ action: 'roster', token: s.tokens.sup4 })));
  chk(r3.every(x => x.out.code === 'IDLE_TIMEOUT') && +new Date(row('sup4')[iL]) === +longAgo, 'S3 idle 3 h: simultaneous requests all IDLE_TIMEOUT and last-activity NOT refreshed');
  const users = ['sup1', 'sup5', 'sup6', 'sup7', 'sup8', 'all1', 'all2', 'leader', 'scout', 'nutri', 'media', 'shirt']; users.forEach(u => { row(u)[iL] = old; }); flush();
  const body = u => u === 'leader' ? { action: 'leaderAll' } : u === 'scout' ? { action: 'gateList' } : u === 'nutri' ? { action: 'nutritionSummary' } : u === 'media' ? { action: 'mediaList' } : u === 'shirt' ? { action: 'shirtStock' } : { action: 'roster', bus: '1' };
  const r4b = await Promise.all(users.flatMap(u => Array.from({ length: 5 }, () => emu.call(Object.assign({ token: s.tokens[u] }, body(u))))));
  const B = JSON.parse(before); const changed = U.filter((x, k) => users.includes(x[0]) && JSON.stringify(x.filter((_, j) => j !== iL)) !== JSON.stringify(B[k])).map(x => x[0]);
  chk(users.every(u => +new Date(row(u)[iL]) > +old) && !changed.length && !r4b.some(x => /IDLE|REVOKED|DISABLED/.test(x.out.code || '')), 'S4 60 simultaneous requests (12 users): last-activity refreshed, no other Users cell changed, nobody logged out');
  row('sup1')[iL] = old; flush();
  const longW = Array.from({ length: 40 }, (_, i) => emu.call({ action: 'scan', op: 'board', token: s.tokens.all1, studentId: String(1005 + 8 * i), clientId: 'L' + i, method: 'qr' }));
  await sleep(150); const r5 = await emu.call({ action: 'roster', token: s.tokens.sup1 }); await Promise.all(longW);
  chk(r5.out.success && r5.ms < 1500 && +new Date(row('sup1')[iL]) > +old, `S5 [C1] while 40 writes queue on the lock, a read answers fast (${Math.round(r5.ms)} ms, target < 1500) and last-activity is written`);
  await emu.close();

  // ---------------- L: login racing a password reset / disable  [C1b] ----------------
  s = seed({ supervisors: 9 }); emu = createEmu(s, { slots: 30, netOverheadMs: 0, lat: REAL });
  const pw = {}; Object.keys(s.tokens).forEach(u => { pw[u] = 'load-test-1'; });
  U = s.book.Users.rows; H = U[0];
  // Deterministic interleaving: the login is PAUSED right before its first write to the Users tab,
  // the admin action runs (or waits for the lock), then the login continues.
  const flushAll = () => Object.keys(emu.cache).forEach(k => delete emu.cache[k]);
  function pauseLoginWrite() { let release; const g = { hit: false, wait: new Promise(r => { release = r; }) }; g.release = () => release();
    emu.cfg.gate = (op, a, act) => { if (!g.hit && act === 'login' && op === 'setValues' && a[0] === 'Users') { g.hit = true; return g.wait; } return null; }; return g; }
  async function until(fn, ms) { const t = Date.now(); while (!fn() && Date.now() - t < ms) await sleep(20); return fn(); }
  let viol = 0, raced = 0; const L1users = ['sup1', 'sup2', 'sup3', 'sup4', 'sup5', 'sup6'];
  for (let k = 0; k < L1users.length; k++) {
    const u = L1users[k], oldPw = pw[u], newPw = 'reset-pass-' + k; flushAll();
    const g = pauseLoginWrite(); const lg = emu.call({ action: 'login', username: u, password: oldPw });
    await until(() => g.hit, 5000);
    const rs = emu.call({ action: 'resetPassword', token: s.tokens.admin, targetUsername: u, newPassword: newPw });
    let rdone = false; rs.then(() => { rdone = true; }); await until(() => rdone, 3000); g.release(); emu.cfg.gate = null;
    const [L1, R1] = [(await lg).out, (await rs).out]; if (R1.success) pw[u] = newPw; else console.log('   reset failed:', R1.error);
    if (L1.success) { raced++; const use = (await emu.call({ action: 'roster', token: L1.token, bus: '1' })).out; if (!/REVOKED/.test(use.code || '')) viol++; }
    if ((await emu.call({ action: 'login', username: u, password: oldPw })).out.success) viol++;
  }
  chk(raced > 0 && viol === 0, `L1 [C1b] login paused between reading and writing while the admin resets the password (${L1users.length} trials, ${raced} logins completed): racing session REVOKED, old password never works — violations: ${viol}`);
  let lviol = 0; const L2users = ['all1', 'all2', 'viewer1', 'viewer2'];
  for (let k = 0; k < L2users.length; k++) {
    const u = L2users[k], oldPw = 'legacy-pass-' + k, newPw = 'after-legacy-' + k;
    const leg = vm.runInContext(`(function(){ const salt = randomBytes_(16); return { salt: Utilities.base64Encode(salt), hex: bytesToHex_(pbkdf2_(${JSON.stringify(oldPw)}, salt, LEGACY_PBKDF2_ITERATIONS, HASH_OUTPUT_BYTES)) }; })()`, s.ctx);
    const rw = U.find(x => x[0] === u); rw[H.indexOf('PasswordHash')] = leg.hex; rw[H.indexOf('Salt')] = leg.salt; flushAll();
    const g = pauseLoginWrite(); const lg = emu.call({ action: 'login', username: u, password: oldPw });
    await until(() => g.hit, 20000);
    const rs = emu.call({ action: 'resetPassword', token: s.tokens.admin, targetUsername: u, newPassword: newPw });
    let rdone = false; rs.then(() => { rdone = true; }); await until(() => rdone, 3000); g.release(); emu.cfg.gate = null;
    await lg; const R2 = (await rs).out; flushAll();
    const oldWorks = (await emu.call({ action: 'login', username: u, password: oldPw })).out.success, newWorks = (await emu.call({ action: 'login', username: u, password: newPw })).out.success;
    if (!R2.success || oldWorks || !newWorks) { lviol++; console.log(`   L2 ${u}: reset=${R2.success} oldWorks=${oldWorks} newWorks=${newWorks}`); }
  }
  chk(lviol === 0, `L2 [C1b] old-format password being upgraded at login while the admin resets it (${L2users.length} trials): new password works, old never — violations: ${lviol}`);
  let dviol = 0;
  for (const u of ['viewer1', 'viewer2', 'viewer3', 'viewer4']) {
    const lg = emu.call({ action: 'login', username: u, password: pw[u] }); await sleep(200);
    await emu.call({ action: 'setUserActive', token: s.tokens.admin, targetUsername: u, active: false }); const L1 = (await lg).out;
    if (L1.success && (await emu.call({ action: 'leaderAll', token: L1.token })).out.success) dviol++;
    if ((await emu.call({ action: 'login', username: u, password: pw[u] })).out.success) dviol++;
  }
  chk(dviol === 0, `L3 login racing an account disable (4 trials): no usable session afterwards — violations: ${dviol}`);
  await emu.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
