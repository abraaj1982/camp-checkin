// Scenario driver. Clients replicate the REAL client logic (supervisor.html queue/flush/retry rules, polling intervals of every screen).
// Load / stress / spike scenarios: REAL server code in the emulator, clients that mirror supervisor.html and every screen's polling.
// FICTIONAL data, nothing leaves this machine.  Run: node tests/load/sim.js expected|peak|spike|stress|breaking|quick  [json overrides]
const fs = require('fs'), path = require('path');
const { seed } = require('./lib/seed'); const { createEmu } = require('./lib/emu');
// The client model reads the real values from supervisor.html so before/after comparisons follow the code.
const SUP = fs.readFileSync(path.join(__dirname, '..', '..', 'supervisor.html'), 'utf8');
const GPS_MS = Number((SUP.match(/const LOC_INTERVAL_MS = (\d+)/) || [])[1]) || 20000;
const OLD_CLIENT = /if \(op\.tries < 5\) break;/.test(SUP); // the old client gave a record up after 5 failed tries; the new one never does
const DROP_AFTER = OLD_CLIENT ? 5 : Infinity;
const PRESETS = {
  quick: { students: 96, durationMs: 150000, viewers: 6, extraPollers: 3 },
  expected: { durationMs: 300000, viewers: 6, extraPollers: 3 },
  peak: { scanEveryMs: [2500, 4000], durationMs: 300000, viewers: 6, extraPollers: 3 },
  spike: { burstStart: true, durationMs: 300000, viewers: 6, extraPollers: 3 },
  stress: { supervisors: 12, scanEveryMs: [3000, 5000], viewers: 4, extraPollers: 3, durationMs: 300000 },
  breaking: { supervisors: 16, scanEveryMs: [2000, 4000], viewers: 6, extraPollers: 6, durationMs: 300000 } };
const pct = (a, q) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };
const R = (a, b) => a + Math.random() * (b - a);
async function run(sc) {
  sc = Object.assign({ name: 'load', students: 300, buses: 8, supervisors: 8, scanEveryMs: [4000, 8000], durationMs: 6 * 60e3, viewers: 2, committees: true, slots: 30, scale: 1, lat: undefined, netOverheadMs: 850,
    gps: true, bagsOn: true, lostReq: 0, lostResp: 0, offline: null, burstStart: false, extraPollers: 0, photoLen: 0, preScans: 0, waves: null }, sc);
  const s = seed({ students: sc.students, buses: sc.buses, supervisors: sc.supervisors, photoLen: sc.photoLen });
  if (sc.preScans) { const h = s.book.Scans.rows[0]; for (let i = 0; i < sc.preScans; i++) { const row = new Array(h.length).fill(''); row[h.indexOf('Time')] = new Date(Date.now() - 864e5); row[h.indexOf('StudentID')] = 'OLD' + i; row[h.indexOf('Action')] = 'board'; row[h.indexOf('Bus')] = '9'; row[h.indexOf('Supervisor')] = 'x'; s.book.Scans.rows.push(row); } }
  const emu = createEmu(s, { slots: sc.slots, scale: sc.scale, lat: sc.lat, netOverheadMs: sc.netOverheadMs });
  const S = sc.scale, sleep = ms => new Promise(r => setTimeout(r, ms * S));
  const t0 = Date.now(), now = () => (Date.now() - t0) / S;
  const M = { lat: {}, err: {}, confirm: [], drops: [], dupLocal: 0, scans: 0, netFail: 0, retries: 0, maxQ: 0, queueTimeline: [] };
  const rec = (k, ms) => (M.lat[k] = M.lat[k] || []).push(ms);
  const recErr = (k, e) => { const key = k + ':' + e; M.err[key] = (M.err[key] || 0) + 1; };
  let stop = false;
  const isOffline = who => sc.offline && sc.offline.who(who) && now() >= sc.offline.from && now() < sc.offline.to;
  async function api(who, body) {
    if (isOffline(who)) { M.netFail++; throw new Error('offline'); }
    if (Math.random() < sc.lostReq) { M.netFail++; await sleep(R(500, 3000)); throw new Error('lost request'); }
    const r = await emu.call(body);
    rec(body.action, r.ms);
    if (r.out && r.out.success === false) recErr(body.action, r.out.code || r.out.error);
    if (Math.random() < sc.lostResp) { M.netFail++; throw new Error('lost response'); } // server DID apply it
    return r.out;
  }
  // ---------- supervisor (mirrors supervisor.html) ----------
  async function supervisor(u, bus, line) {
    const tok = s.tokens[u]; const queue = []; let flushing = false; const local = {};
    async function flush() {
      if (flushing || !queue.length || isOffline(u)) return; flushing = true;
      try {
        const nextOp = () => { const t = Date.now(), held = {}; for (let i = 0; i < queue.length; i++) { const o = queue[i], k = o.body.studentId ? 's' + o.body.studentId : 'o' + i; if (!held[k] && !(o.nextAt > t)) return i; held[k] = true; } return -1; };
        let i;
        while ((i = OLD_CLIENT ? (queue.length ? 0 : -1) : nextOp()) !== -1) {
          const op = queue[i]; let r;
          try { r = await api(u, Object.assign({ token: tok }, op.body)); } catch (e) { break; }
          if (!r || (r.success === false && !r.code)) {
            op.tries = (op.tries || 0) + 1; M.retries++;
            if (OLD_CLIENT) { if (op.tries < 5) break; M.drops.push({ u, kind: op.kind, id: op.body.studentId, err: r && r.error }); }
            else { op.nextAt = Date.now() + [5000, 15000, 30000, 60000][Math.min(op.tries, 4) - 1] * S; continue; } // new client: never gives up
          }
          queue.splice(queue.indexOf(op), 1);
          if (op.kind === 'scan' && r && r.success) M.confirm.push(now() - op.t);
        }
      } finally { flushing = false; }
      try { await api(u, { action: 'roster', token: tok }); } catch (e) {}
    }
    const enqueue = (kind, body) => { queue.push({ kind, body: Object.assign({ clientId: u + '-' + Math.random().toString(36).slice(2) }, body), t: now() }); M.maxQ = Math.max(M.maxQ, queue.length); flush(); };
    try { await api(u, { action: 'roster', token: tok }); } catch (e) {}
    const timers = [setInterval(() => { if (queue.length) flush(); }, 15000 * S), setInterval(() => { if (!isOffline(u)) api(u, { action: 'roster', token: tok }).catch(() => {}); }, 60000 * S)];
    if (sc.gps) timers.push(setInterval(() => { if (!isOffline(u)) api(u, { action: 'busStatus', token: tok, lat: 23.6 + Math.random() / 100, lng: 58.1, acc: 10 }).catch(() => {}); }, (sc.gpsEveryMs || GPS_MS) * S));
    for (const st of line) {
      if (stop) break;
      if (sc.burstStart !== true) await sleep(R(sc.scanEveryMs[0], sc.scanEveryMs[1]));
      if (local[st.id]) { M.dupLocal++; continue; }
      local[st.id] = 1; M.scans++; M.lastScanAt = now();
      enqueue('scan', Object.assign({ action: 'scan', op: 'board', studentId: st.id, method: 'qr' }, sc.mergeBags && sc.bagsOn && st.bags > 0 ? { bags: st.bags } : {}));
      if (!sc.mergeBags && sc.bagsOn && st.bags > 0) enqueue('bag', { action: 'bag', studentId: st.id, mode: 'load', count: st.bags });
    }
    while (!stop && queue.length) await sleep(1000);
    // drain: keep retrying as the real app does (timer every 15 s)
    const until = Date.now() + 120e3 * S; while (queue.length && Date.now() < until) { await flush(); await sleep(15000); }
    timers.forEach(clearInterval);
    return queue.length;
  }
  async function poller(u, body, every) { while (!stop) { try { await api(u, Object.assign({ token: s.tokens[u] }, body)); } catch (e) {} await sleep(every); } }
  // ---------- start ----------
  const byBus = {}; s.students.forEach(x => (byBus[x.bus] = byBus[x.bus] || []).push(x));
  const sups = [];
  for (let i = 1; i <= sc.supervisors; i++) { const bus = String(1 + (i - 1) % sc.buses); const all = byBus[bus]; const share = all.filter((x, k) => Math.floor(k * Math.ceil(sc.supervisors / sc.buses) / all.length) === Math.floor((i - 1) / sc.buses)); sups.push(supervisor('sup' + i, bus, share)); }
  const polls = [];
  for (let v = 0; v < sc.viewers; v++) polls.push(poller(v === 0 ? 'leader' : v === 1 ? 'leader2' : 'viewer' + (v - 1), { action: 'leaderAll' }, 15000));
  if (sc.committees) {
    polls.push(poller('scout', { action: 'gateList' }, 10000), poller('nutri', { action: 'nutritionSummary' }, 30000), poller('doctor', { action: 'medList' }, 30000),
      poller('secr', { action: 'receptionList' }, 30000), poller('media', { action: 'mediaList' }, 30000), poller('all1', { action: 'lookup', q: '10' }, 10000), poller('all2', { action: 'lookup', q: 'علي' }, 12000));
    polls.push((async () => { while (!stop) { try { await api('display', { action: 'feed', key: s.feedKey }); } catch (e) {} await sleep(20000); } })());
  }
  for (let k = 0; k < sc.extraPollers; k++) polls.push(poller(['viewer1', 'viewer2', 'viewer3', 'viewer4', 'viewer5', 'viewer6'][k % 6], { action: 'leaderAll' }, 5000));
  const q = setInterval(() => M.queueTimeline.push([Math.round(now() / 1000), emu.stats.maxQueue]), 10000 * S);
  const left = await Promise.all(sups);
  const scanDone = now();
  await sleep(Math.max(0, sc.durationMs - now()));
  stop = true; clearInterval(q); await Promise.race([Promise.all(polls), sleep(20000)]);
  // ---------- integrity ----------
  const sv = s.book.Scans.rows, h = sv[0], iS = h.indexOf('StudentID'), iA = h.indexOf('Action'), iC = h.indexOf('ClientId');
  const boards = {}, cids = {}; let dupBoard = 0, dupCid = 0;
  for (let r = 1; r < sv.length; r++) { const id = String(sv[r][iS]); if (id.startsWith('OLD')) continue; if (sv[r][iA] === 'board') { boards[id] = (boards[id] || 0) + 1; if (boards[id] > 1) dupBoard++; } else if (sv[r][iA] === 'undo') boards[id] = 0; const c = sv[r][iC]; if (c) { if (cids[c]) dupCid++; cids[c] = 1; } }
  const boardedServer = Object.keys(boards).filter(k => boards[k] > 0).length;
  const bv = s.book.Bags.rows; const bagC = {}; let dupBag = 0; for (let r = 1; r < bv.length; r++) { const c = bv[r][7]; if (c) { if (bagC[c]) dupBag++; bagC[c] = 1; } }
  const st = emu.stats;
  const out = { scenario: sc.name, users: sc.supervisors + sc.viewers + (sc.committees ? 8 : 0) + sc.extraPollers, students: sc.students, scansAttempted: M.scans,
    boardedOnServer: boardedServer, lost: M.scans - boardedServer, droppedAfter5Tries: M.drops.length, leftInQueues: left.reduce((a, b) => a + b, 0), duplicateBoardRows: dupBoard, duplicateClientIds: dupCid + dupBag,
    allScansConfirmedAtSec: Math.round(scanDone / 1000), confirmP50s: +(pct(M.confirm, .5) / 1000).toFixed(1), confirmP95s: +(pct(M.confirm, .95) / 1000).toFixed(1), confirmMaxS: +(pct(M.confirm, 1) / 1000).toFixed(1), maxClientQueue: M.maxQ,
    lockTimeouts: st.lockTimeouts, lockWaitP50: pct(st.lockWaitMs, .5) / S | 0, lockWaitP95: pct(st.lockWaitMs, .95) / S | 0, lockWaitMax: pct(st.lockWaitMs, 1) / S | 0, lockHoldP50: pct(st.lockHoldMs, .5) / S | 0, lockHoldP95: pct(st.lockHoldMs, .95) / S | 0, lockAcquisitions: st.lockHoldMs.length,
    peakBusySlots: st.busyMax, slotQueueMax: st.maxQueue, retries: M.retries, netFailures: M.netFail, errors: M.err,
    latency: Object.fromEntries(Object.entries(M.lat).map(([k, a]) => [k, { n: a.length, p50: +(pct(a, .5) / 1000).toFixed(2), p95: +(pct(a, .95) / 1000).toFixed(2), max: +(pct(a, 1) / 1000).toFixed(2) }])),
    lockHoldByAction: Object.fromEntries(Object.entries(st.holdBy).map(([k, a]) => [k, { n: a.length, avgMs: Math.round(a.reduce((x, y) => x + y, 0) / a.length / S) }])), physicalScanEndSec: Math.round(M.lastScanAt / 1000), bagRows: bv.length - 1,
    scansRows: sv.length - 1, auditRows: s.book.AuditLog.rows.length - 1, studentsCacheBytes: (emu.cache.students_v2 && emu.cache.students_v2.v.length) || 'NOT CACHED' };
  await emu.close();
  return out;
}
module.exports = { run };
if (require.main === module) {
  const name = process.argv[2] || 'quick'; const sc = Object.assign({ name }, PRESETS[name] || {}, JSON.parse(process.argv[3] || '{}'));
  run(sc).then(o => { o.client = { gpsEveryMs: sc.gpsEveryMs || GPS_MS, dropAfter: DROP_AFTER }; const dir = path.join(__dirname, 'results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sim_' + name + '.json'), JSON.stringify(o, null, 1));
    const { latency, ...k } = o; console.log(JSON.stringify(k, null, 1)); console.log('latency', JSON.stringify(latency)); process.exit(0); }); }
