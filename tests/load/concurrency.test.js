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
  chk(r1.success && a1.code === 'REVOKED', 'S1 password reset during 20 in-flight requests -> old token REVOKED afterwards' + (r1.success && a1.code === 'REVOKED' ? '' : ` (reset: ${r1.success ? 'ok' : r1.error}; old token afterwards: ${a1.code || 'ACCEPTED'})`));
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
  // S6: a request that READ the users table just before a password reset must not put that stale copy
  // back into the cache (otherwise the old session keeps working for up to 60 s). Deterministic: the reader is paused mid-read.
  flush(); let rel6; const g6 = { hit: false, wait: new Promise(r => { rel6 = r; }) };
  emu.cfg.gate = (op, a, act) => { if (!g6.hit && act === 'roster' && op === 'cput' && a[0] === 'users_v1') { g6.hit = true; return g6.wait; } return null; };
  const reader = emu.call({ action: 'roster', token: s.tokens.sup6 }); const t6 = Date.now(); while (!g6.hit && Date.now() - t6 < 5000) await sleep(10);
  const rs6 = (await emu.call({ action: 'resetPassword', token: s.tokens.admin, targetUsername: 'sup6', newPassword: 'new-pass-666' })).out;
  rel6(); emu.cfg.gate = null; await reader;
  const a6 = (await emu.call({ action: 'roster', token: s.tokens.sup6 })).out;
  chk(g6.hit && rs6.success && a6.code === 'REVOKED', 'S6 [C1] a request that read the users table just before a password reset does not keep the old session alive' + (a6.code === 'REVOKED' ? '' : ` (old token afterwards: ${a6.code || 'ACCEPTED'})`));
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

  // ---------------- R: reception — unique student numbers (RC4) ----------------
  s = seed({ supervisors: 9 }); emu = createEmu(s, { slots: 30, netOverheadMs: 0, lat: SMALL });
  const rcall = b => emu.call(b).then(x => x.out); const extra = () => s.book.ExtraStudents.rows.slice(1);
  const dupIds = () => { const all = extra().map(r => r[0]).concat(s.book.Bus.rows.slice(1).map(r => r[3])); return all.filter((x, i) => all.indexOf(x) !== i); };
  const add = (name, k, bus) => rcall({ action: 'receptionAdd', token: s.tokens.secr, name, cls: '6', team: 'الأزرق', bus: bus === undefined ? '1' : bus, clientId: 'radd-' + k });
  let ra = await Promise.all(Array.from({ length: 10 }, (_, i) => add('متأخر متزامن تجريبي ' + i, i)));
  chk(ra.every(x => x.success) && new Set(ra.map(x => x.id)).size === 10 && !dupIds().length, 'R1 [D1] 10 late students added at the same instant: 10 different numbers');
  // stale cache: a reader loads the student list BEFORE an add and stores it AFTER (deterministic pause)
  const pauseStudentsCachePut = () => { let rel; const g = { hit: false, wait: new Promise(r => { rel = r; }) }; g.release = () => rel();
    emu.cfg.gate = (op, a, act) => { if (!g.hit && act === 'roster' && op === 'cput' && a[0] === 'students_v2') { g.hit = true; return g.wait; } return null; }; return g; };
  flush(); let g7 = pauseStudentsCachePut(); const reader7 = rcall({ action: 'roster', token: s.tokens.sup1 }); let t7 = Date.now(); while (!g7.hit && Date.now() - t7 < 5000) await sleep(10);
  const A = await add('متأخر أ تجريبي', 'a'); g7.release(); emu.cfg.gate = null; await reader7;
  const vis = await Promise.all([rcall({ action: 'roster', token: s.tokens.sup1 }), rcall({ action: 'receptionFind', token: s.tokens.secr, q: A.id.toLowerCase() }), rcall({ action: 'reportData', token: s.tokens.admin, report: 'busAttendance', filters: { bus: '1' } })]);
  const seen = [vis[0].students && vis[0].students.some(x => x.id === A.id), vis[1].results && vis[1].results.some(x => x.id === A.id), vis[2].rows && vis[2].rows.some(x => x.id === A.id)];
  chk(g7.hit && seen.every(Boolean), `R2 [D1] a student list read before an add and cached after it does not hide the new student (roster/reception/report: ${seen.join('/')})`);
  const B2 = await add('متأخر ب تجريبي', 'b');
  chk(A.success && B2.success && A.id !== B2.id && !dupIds().length, `R3 [D1] RC4 the next add after that stale cache gets a NEW number (${A.id} / ${B2.id}; duplicates: ${dupIds().join(',') || 'none'})`);
  // a number already used in the REGISTRATION sheet is never reused
  const ix = s.book.Bus.rows[0].indexOf('Student ID'); const used = 'X' + (Math.max(...extra().map(r => Number(String(r[0]).slice(1)))) + 1); s.book.Bus.rows[5][ix] = used; flush();
  const C3 = await add('متأخر ج تجريبي', 'c');
  chk(C3.success && C3.id !== used && !dupIds().length, `R4 [D1] a number already used in the registration sheet (${used}) is not given again (got ${C3.id})`);
  // 20 additions while supervisors keep reading the roster (natural interleavings)
  let stop = false; const pollers = Array.from({ length: 6 }, (_, k) => (async () => { while (!stop) { flush(); await rcall({ action: 'roster', token: s.tokens['sup' + (k + 1)] }); } })());
  ra = await Promise.all(Array.from({ length: 20 }, (_, i) => add('متأخر مع قراءات تجريبي ' + i, 'p' + i))); stop = true; await Promise.all(pollers);
  chk(ra.every(x => x.success) && new Set(ra.map(x => x.id)).size === 20 && !dupIds().length, `R5 [D1] 20 additions at once while 6 supervisors keep reloading their rosters: all numbers unique (${extra().length} hand-added, no duplicate)`);
  // existing records untouched
  chk(extra().every(r => r[9] === true) && s.book.Bus.rows.length === 301, 'R6 [D1] existing students and earlier hand-added records are untouched');
  // bus validation
  const bad = await add('باص غير موجود تجريبي', 'bad', '99'), none = await add('بلا باص تجريبي', 'nob', ''), ok8 = await add('باص صحيح تجريبي', 'okb', '8');
  chk(bad.code === 'BAD_REQUEST' && !bad.success && none.success && ok8.success && !extra().some(r => r[1] === 'باص غير موجود تجريبي'), `R7 [D3] bus that does not exist is refused (${bad.code}: ${bad.error}); no bus (arrives with guardian) and an existing bus are accepted`);
  await emu.close();

  // ---------------- B: concurrent wrong passwords cannot bypass the lockout [D2] ----------------
  const LOCKMSG = 'Account temporarily locked. Try again later.';
  async function lockState(sx, u) { const U2 = sx.book.Users.rows, H2 = U2[0], r = U2.find(x => x[0] === u); return { fa: Number(r[H2.indexOf('FailedAttempts')]) || 0, locked: !!r[H2.indexOf('LockedUntil')] && new Date(r[H2.indexOf('LockedUntil')]) > new Date() }; }
  s = seed({ supervisors: 4 }); emu = createEmu(s, { slots: 60, netOverheadMs: 0 });
  await Promise.all(Array.from({ length: 50 }, (_, i) => emu.call({ action: 'login', username: 'sup1', password: 'wrong-' + i })));
  let ls = await lockState(s, 'sup1'); const right = (await emu.call({ action: 'login', username: 'sup1', password: 'load-test-1' })).out;
  chk(ls.locked && ls.fa >= 5 && !right.success, `B1 [D2] 50 wrong passwords at the same time: counted ${ls.fa}, account locked: ${ls.locked}; correct password right after refused: ${!right.success}`);
  const mixed = await Promise.all(Array.from({ length: 51 }, (_, i) => emu.call({ action: 'login', username: 'sup2', password: i === 25 ? 'load-test-1' : 'bad-' + i }).then(x => x.out)));
  ls = await lockState(s, 'sup2'); const good = mixed[25], wrongMsgs = new Set(mixed.filter((_, i) => i !== 25).map(x => x.error));
  chk(ls.locked && (good.success || wrongMsgs.has(good.error)), `B2 [D2] 50 wrong + 1 correct at the same time: account locked; the correct one ${good.success ? 'got in before the lock' : 'got the SAME answer as wrong guesses ("' + good.error + '") — no hint that it was right'}`);
  // a correct login paused just before writing, while 6 wrong ones arrive: it must not erase the lock they cause
  { let rel; const g = { hit: false, wait: new Promise(r => { rel = r; }) };
    emu.cfg.gate = (op, a, act) => { if (!g.hit && act === 'login' && op === 'setValues' && a[0] === 'Users' && Array.isArray(a[3]) && a[3][0] && a[3][0].length === 2) { g.hit = true; return g.wait; } return null; };
    const lg = emu.call({ action: 'login', username: 'sup3', password: 'load-test-1' }); let t = Date.now(); while (!g.hit && Date.now() - t < 8000) await sleep(10);
    const wrongs = Promise.all(Array.from({ length: 6 }, (_, i) => emu.call({ action: 'login', username: 'sup3', password: 'w-' + i })));
    let wd = false; wrongs.then(() => { wd = true; }); t = Date.now(); while (!wd && Date.now() - t < 3000) await sleep(20); rel(); emu.cfg.gate = null; await lg; await wrongs;
    ls = await lockState(s, 'sup3');
    chk(g.hit && ls.locked && ls.fa >= 5, `B3 [D2] a correct login finishing while 6 wrong attempts arrive does not erase the lock (counted ${ls.fa}, locked: ${ls.locked})`); }
  // normal behaviour kept
  for (let i = 0; i < 3; i++) await emu.call({ action: 'login', username: 'sup4', password: 'oops-' + i });
  const n4 = (await emu.call({ action: 'login', username: 'sup4', password: 'load-test-1' })).out; ls = await lockState(s, 'sup4');
  chk(n4.success && n4.token && ls.fa === 0 && !ls.locked, 'B4 [D2] 3 wrong then the right password: logs in, counter back to 0 (unchanged behaviour)');
  const un = (await emu.call({ action: 'unlockAccount', token: s.tokens.admin, targetUsername: 'sup1' })).out; const after = (await emu.call({ action: 'login', username: 'sup1', password: 'load-test-1' })).out;
  chk(un.success && after.success, 'B5 [D2] after the admin unlocks the account, the right password works again');
  await emu.close();
  done();
})().catch(e => { console.error(e); process.exit(2); });
