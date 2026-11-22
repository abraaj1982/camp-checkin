// LOAD test against a SEPARATE deployment with its OWN empty spreadsheet holding only FICTIONAL data (tests/load/load-data.js).
// It WRITES to that spreadsheet (users, scans, bags, bus positions) — that is the point — so it is guarded three ways:
//  1. guard.js: explicit opt-in, an Apps Script /exec URL, and never a deployment id used by this repository's pages (production);
//  2. the Users tab must be EMPTY: the first thing it does is bootstrap its own admin, which the server only allows on an empty Users
//     tab — TEST and production have users, so the run stops there, before anything else is written;
//  3. before any scan is written, EVERY student of the deployment must look fictional (name ends with «التجريبي», 4-digit id).
// Usage (real):  MK_I_CONFIRM_NOT_PRODUCTION=yes MK_BOOTSTRAP_SECRET=<from ADMIN_printBootstrapSecret> node tests/load/load-real.js <exec url> [--fast]
// Usage (rehearsal on the local emulator, no Google): node tests/load/load-real.js --local [--fast]
const fs = require('fs'), path = require('path');
const { assertSafeTarget } = require('./guard'); const { looksFictional } = require('./load-data');
const args = process.argv.slice(2), LOCAL = args.includes('--local'), FAST = args.includes('--fast'), url0 = args.find(a => /^https?:/.test(a));
const sleep = ms => new Promise(r => setTimeout(r, ms)), R = (a, b) => a + Math.random() * (b - a);
const pct = (a, q) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
const PW = 'load-test-pass-1';
let URL_, emuHandle = null;
const M = { lat: {}, err: {}, net: 0 };
async function api(body, opts) {
  const t = Date.now(); let out;
  try { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
    const r = await fetch(URL_, { method: 'POST', body: JSON.stringify(body), redirect: 'follow', signal: ctl.signal }); clearTimeout(tm); out = await r.json(); }
  catch (e) { M.net++; out = { success: false, __net: true, error: String(e.message || e) }; }
  const ms = Date.now() - t; if (!(opts && opts.quiet)) { (M.lat[body.action] = M.lat[body.action] || []).push(ms); if (out.success === false) { const k = body.action + ':' + (out.code || out.error); M.err[k] = (M.err[k] || 0) + 1; } }
  out.__ms = ms; return out;
}
const must = async (body, what) => { const r = await api(body, { quiet: true }); if (!r.success) throw new Error('setup step failed (' + what + '): ' + (r.error || JSON.stringify(r))); return r; };
const stop = msg => { console.error('\nSTOPPED (nothing further was written): ' + msg); process.exit(3); };

async function setup(secret) {
  const h = await (await fetch(URL_)).json().catch(() => null); if (!h || h.service !== 'mukhayyam') stop('the URL did not answer like a MUKHAYYAM deployment');
  const b = await api({ action: 'createUser', username: 'loadadmin', password: PW, fullName: 'مدير تجريبي', bootstrapSecret: secret }, { quiet: true });
  if (!b.success) stop('could not bootstrap an admin (' + (b.error || 'unknown') + '). This deployment is NOT fresh/empty (or the secret is wrong): a LOAD deployment must start with an empty Users tab. Refusing to continue.');
  const adm = (await must({ action: 'login', username: 'loadadmin', password: PW }, 'admin login')).token;
  const mk = (u, role, bus, perms) => must({ action: 'createUser', token: adm, username: u, password: PW, fullName: 'مستخدم ' + u, role, assignedBus: bus || '', permissions: perms, committees: [] }, 'create ' + u);
  for (let i = 1; i <= 8; i++) await mk('lsup' + i, 'supervisor', String(i));
  await mk('lall1', 'supervisor', '', ['checkin', 'allbuses']); await mk('lall2', 'supervisor', '', ['checkin', 'allbuses']);
  await mk('lleader', 'camp_leader', '', ['dashboard', 'stats', 'allbuses']); for (let i = 1; i <= 6; i++) await mk('lview' + i, 'camp_leader', '', ['dashboard', 'stats']);
  await mk('lsecr', 'supervisor', '', ['reports', 'custody', 'print', 'reception']); await mk('ldoc', 'supervisor', '', ['medical']); await mk('lnut', 'supervisor', '', ['nutrition']); await mk('lgate', 'supervisor', '', ['gate']); await mk('lmedia', 'supervisor', '', ['announce', 'results', 'verify']);
  const T = { admin: adm }; for (const u of ['lsup1', 'lsup2', 'lsup3', 'lsup4', 'lsup5', 'lsup6', 'lsup7', 'lsup8', 'lall1', 'lall2', 'lleader', 'lview1', 'lview2', 'lview3', 'lsecr', 'ldoc', 'lnut', 'lgate', 'lmedia']) T[u] = (await must({ action: 'login', username: u, password: PW }, 'login ' + u)).token;
  const pl = await must({ action: 'printList', token: adm }, 'read student list (print)');
  if (!looksFictional(pl.students)) stop('the student list is empty or contains names that do not look fictional (' + pl.students.length + ' students). Paste tests/load/load-data.js output into the Bus tab of the EMPTY LOAD sheet.');
  return { T, students: pl.students };
}

// one supervisor: a queue sent in order, like supervisor.html (retry later when the server is busy, never give up)
function makeSupervisor(u, tok, list, o) {
  const q = []; let working = false, done = 0; const delays = [], sent = [];
  async function work() { if (working) return; working = true;
    while (q.length) { const op = q[0]; const r = await api(Object.assign({ token: tok }, op.body));
      if (r.success === false && !r.code) { op.tries = (op.tries || 0) + 1; await sleep(Math.min(5000 * op.tries, 30000)); continue; } // busy / temporary: retry
      q.shift(); if (op.kind === 'scan') { delays.push(Date.now() - op.t); if (r.success || r.code === 'DUPLICATE') sent.push(op.body.studentId); } done++; }
    working = false; }
  const enq = (kind, body) => { q.push({ kind, body: Object.assign({ clientId: u + '-' + Math.random().toString(36).slice(2) }, body), t: Date.now() }); work(); };
  async function run(untilMs) { const gps = o.gps ? setInterval(() => api({ action: 'busStatus', token: tok, lat: 23.6 + Math.random() / 100, lng: 58.1, acc: 10 }), o.gpsMs) : null;
    for (const st of list) { if (Date.now() > untilMs) break; if (o.pace) await sleep(R(o.pace[0], o.pace[1]));
      enq('scan', { action: 'scan', op: 'board', studentId: st.id, method: 'qr' }); if (o.bags && Number(st.bags) > 0) enq('bag', { action: 'bag', studentId: st.id, mode: 'load', count: Number(st.bags) });
      if (!o.pace) while (q.length > 1) await sleep(50); }
    while (q.length) await sleep(200); if (gps) clearInterval(gps); }
  return { run, delays, sent };
}
const busList = (students, b) => students.filter(s => String(s.bus) === String(b));
async function reset(T, students, ids) { const a = [...ids]; await Promise.all(Array.from({ length: 6 }, async () => { while (a.length) { const id = a.shift(); await api({ action: 'scan', op: 'undo', token: T.admin, studentId: id, clientId: 'rs-' + id + Math.random(), method: 'undo' }, { quiet: true }); } })); }
async function pollers(T, stopFlag) { const loops = [['lleader', { action: 'leaderAll' }, 15000], ['lview1', { action: 'leaderAll' }, 15000], ['lview2', { action: 'leaderAll' }, 15000], ['lgate', { action: 'gateList' }, 10000], ['lnut', { action: 'nutritionSummary' }, 30000], ['ldoc', { action: 'medList' }, 30000], ['lsecr', { action: 'receptionList' }, 30000], ['lall1', { action: 'lookup', q: '10' }, 10000]];
  return loops.map(async ([u, b, ms]) => { while (!stopFlag.v) { await api(Object.assign({ token: T[u] }, b)); await sleep(ms); } }); }
function snapshot(name, t0, sups) { const all = sups.flatMap(s => s.delays); const lat = {}; Object.entries(M.lat).forEach(([k, a]) => { lat[k] = { n: a.length, p50: pct(a, .5), p95: pct(a, .95), max: Math.max(...a) }; });
  return { scenario: name, seconds: Math.round((Date.now() - t0) / 1000), scans: all.length, confirmDelayMs: { p50: pct(all, .5), p95: pct(all, .95), max: Math.max(0, ...all) }, errors: Object.assign({}, M.err), networkFailures: M.net, latencyMs: lat }; }
const fresh = () => { M.lat = {}; M.err = {}; M.net = 0; };

async function scenario(name, T, students, cfg) {
  fresh(); const t0 = Date.now(); const stopFlag = { v: false }; const sups = [];
  for (let i = 1; i <= 8; i++) sups.push(makeSupervisor('lsup' + i, T['lsup' + i], busList(students, i).slice(0, cfg.perBus || 999), cfg));
  const polls = cfg.pollers ? await pollers(T, stopFlag) : [];
  const until = Date.now() + cfg.maxMs; await Promise.all(sups.map(s => s.run(until))); stopFlag.v = true; await Promise.race([Promise.all(polls), sleep(15000)]);
  const res = snapshot(name, t0, sups); const sentIds = sups.flatMap(s => s.sent);
  const lead = await api({ action: 'leaderAll', token: T.lleader }, { quiet: true });
  res.serverBoarded = lead.summary ? lead.summary.boarded : null; res.expectedBoarded = new Set(sentIds).size; res.integrityOk = res.serverBoarded === res.expectedBoarded;
  await reset(T, students, sentIds); return res;
}

(async () => {
  let secret = process.env.MK_BOOTSTRAP_SECRET;
  if (LOCAL) { const { startServers } = require('./lib/servers'); const { REAL_LAT } = {}; emuHandle = await startServers({ seed: { bare: true, students: 300, supervisors: 8 }, slots: 30, lat: { open: 400, readBase: 120, readPerKCell: 25, append: 250, set: 150, getRange: 80, cache: 15, props: 20, lock: 20 } });
    URL_ = emuHandle.apiUrl; secret = emuHandle.s.bootstrapSecret(); console.log('LOCAL rehearsal on the emulator (no Google):', URL_); }
  else { URL_ = assertSafeTarget(url0); if (!secret) stop('set MK_BOOTSTRAP_SECRET (the value printed by ADMIN_printBootstrapSecret in the LOAD script editor)'); console.log('REAL run against', URL_.slice(0, 60) + '…'); }
  const { T, students } = await setup(secret); console.log('setup ok:', students.length, 'fictional students, 27 users');
  const D = FAST ? { base: 8, sat: 20000, exp: 40000, peak: 30000 } : { base: 20, sat: 45000, exp: 300000, peak: 300000 };
  const out = { startedAt: new Date().toISOString(), target: LOCAL ? 'local-emulator' : 'real', fast: FAST, scenarios: [] }; const note = r => { out.scenarios.push(r); console.log(JSON.stringify({ scenario: r.scenario, scans: r.scans, confirmMs: r.confirmDelayMs, errors: r.errors, integrity: r.integrityOk })); };
  // A: one supervisor, one request at a time: the real cost of a single scan from this machine
  fresh(); { const s = makeSupervisor('lsup1', T.lsup1, busList(students, 1).slice(0, D.base), { pace: null }); const t0 = Date.now(); await s.run(Date.now() + 120000); const r = snapshot('A-single-supervisor', t0, [s]); r.serverBoarded = null; note(r); await reset(T, students, s.sent); }
  // B: SATURATION — 8 supervisors send back-to-back. Throughput = 1 / (time the shared write lock is held per scan).
  { fresh(); const t0 = Date.now(); const sups = []; for (let i = 1; i <= 8; i++) sups.push(makeSupervisor('lsup' + i, T['lsup' + i], busList(students, i), { pace: null })); const until = Date.now() + D.sat;
    await Promise.all(sups.map(s => s.run(until))); const r = snapshot('B-saturation-8-back-to-back', t0, sups); const secs = (Date.now() - t0) / 1000; r.opsPerSecond = +(r.scans / secs).toFixed(2); r.estimatedLockHoldMs = Math.round(1000 / (r.scans / secs)); note(r); await reset(T, students, sups.flatMap(s => s.sent)); }
  await scenario('C-expected-pace', T, students, { pace: [4000, 8000], gps: true, gpsMs: 45000, bags: true, pollers: true, maxMs: D.exp, perBus: FAST ? 6 : 999 }).then(note);
  await scenario('D-peak-pace', T, students, { pace: [2500, 4000], gps: true, gpsMs: 45000, bags: true, pollers: true, maxMs: D.peak, perBus: FAST ? 8 : 999 }).then(note);
  out.finishedAt = new Date().toISOString(); const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'load_real_' + (LOCAL ? 'local_' : '') + Date.now() + '.json'); fs.writeFileSync(f, JSON.stringify(out, null, 1));
  console.log('\nresults file:', f); if (emuHandle) await emuHandle.close(); process.exit(out.scenarios.every(s => s.integrityOk !== false) ? 0 : 1);
})().catch(e => { console.error('ERROR', e.message); process.exit(2); });
