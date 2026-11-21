// Apps Script emulator: worker pool = simultaneous executions; ONE script lock (FIFO, waitLock timeout);
// shared CacheService with TTL; latency model per Sheets call (calibrated from real TEST measurements).
const { Worker, MessageChannel } = require('worker_threads');
function createEmu(seedOut, cfg) {
  cfg = Object.assign({ slots: 30, scale: 1, netOverheadMs: 850 }, cfg || {}); if (cfg.lat === undefined) delete cfg.lat;
  cfg.lat = Object.assign({ open: 400, readBase: 120, readPerKCell: 25, append: 250, set: 150, getRange: 80, cache: 15, props: 20, lock: 20 }, cfg.lat || {});
  const { book, props } = seedOut, cache = {};
  const L = cfg.lat, S = cfg.scale;
  const stats = { calls: {}, lockWaitMs: [], lockHoldMs: [], lockTimeouts: 0, execMs: [], maxQueue: 0, busyMax: 0 };
  // ---- the single script lock ----
  let lockOwner = null, lockSince = 0, lockAction = ''; stats.holdBy = {}; const lockQ = [];
  function grant() { while (lockOwner === null && lockQ.length) { const w = lockQ.shift(); if (w.done) continue; w.done = true; clearTimeout(w.timer); lockOwner = w.who; lockSince = Date.now(); lockAction = w.action; stats.lockWaitMs.push(Date.now() - w.t0); w.ok(); } }
  function lock(who, ms, ok, fail, action) { const w = { who, t0: Date.now(), ok, done: false, action }; w.timer = setTimeout(() => { if (w.done) return; w.done = true; stats.lockTimeouts++; fail('Lock timeout: another process was holding the lock for too long.'); }, ms * S); lockQ.push(w); grant(); }
  function unlock(who) { if (lockOwner !== null && lockOwner === who) { const hd = Date.now() - lockSince; stats.lockHoldMs.push(hd); (stats.holdBy[lockAction] = stats.holdBy[lockAction] || []).push(hd); lockOwner = null; grant(); } }
  const cells = n => book[n].rows.reduce((a, r) => a + r.length, 0);
  function handle(slot, op, a, reply, act) {
    // optional test hook: pause one specific call (deterministic interleavings), then continue
    const g = cfg.gate && cfg.gate(op, a, act); if (g) { cfg.gate.used = (cfg.gate.used || 0) + 1; return g.then(() => run(slot, op, a, reply)); }
    return run(slot, op, a, reply);
  }
  function run(slot, op, a, reply) {
    stats.calls[op] = (stats.calls[op] || 0) + 1;
    const later = (ms, fn) => setTimeout(() => { let v; try { v = fn(); } catch (e) { return reply({ __err: e.message }); } reply(v); }, Math.max(0, ms * S));
    switch (op) {
      case 'open': return later(L.open, () => true);
      case 'has': return later(5, () => !!book[a[0]]);
      case 'read': return later(L.readBase + L.readPerKCell * cells(a[0]) / 1000, () => book[a[0]].rows.map(r => r.slice()));
      case 'lastRow': return later(L.getRange, () => book[a[0]].rows.length);
      case 'lastCol': return later(L.getRange, () => Math.max(...book[a[0]].rows.map(r => r.length), 1));
      case 'append': return later(L.append, () => { book[a[0]].rows.push(a[1]); return true; });
      case 'setValues': return later(L.set, () => { const [n, r, c, vs] = a, rows = book[n].rows; vs.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; row.forEach((v, j) => rows[r - 1 + i][c - 1 + j] = v); }); return true; });
      case 'getRange': return later(L.getRange, () => { const [n, r, c, nr, nc] = a, rows = book[n].rows, o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? ''); o.push(row); } return o; });
      case 'cget': return later(L.cache, () => { const e = cache[a[0]]; return e && e.exp > Date.now() ? e.v : null; });
      case 'cput': return later(L.cache, () => { if (a[1].length > 100 * 1024) throw new Error('Argument too large: value'); cache[a[0]] = { v: a[1], exp: Date.now() + (a[2] || 600) * 1000 * S }; return true; });
      case 'cdel': return later(L.cache, () => { a[0].forEach(k => delete cache[k]); return true; });
      case 'pget': return later(L.props, () => props[a[0]] || null);
      case 'pset': return later(L.props, () => { if (a[1] === null) delete props[a[0]]; else props[a[0]] = a[1]; return true; });
      case 'lock': return setTimeout(() => lock(slot, a[0], () => reply(true), e => reply({ __err: e }), a[1]), L.lock * S);
      case 'unlock': unlock(slot); return reply(true);
    }
    reply({ __err: 'bad op ' + op });
  }
  const workers = [], free = [], waiting = [], pending = {};
  let nextId = 1, busy = 0;
  for (let i = 0; i < cfg.slots; i++) {
    const sab = new SharedArrayBuffer(4), flag = new Int32Array(sab), ch = new MessageChannel();
    const w = new Worker(__dirname + '/worker.js', { workerData: { sab, port: ch.port2 }, transferList: [ch.port2] });
    ch.port1.on('message', m => handle(i, m.op, m.a, v => { ch.port1.postMessage(v); Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); }, m.act));
    w.on('message', m => { stats.execMs.push(m.ms); const p = pending[m.id]; delete pending[m.id]; busy--; free.push(w); pump(); p(m.out); });
    w.on('error', e => console.error('worker error', e));
    workers.push(w); free.push(w);
  }
  function pump() { while (free.length && waiting.length) { const j = waiting.shift(); const w = free.pop(); busy++; stats.busyMax = Math.max(stats.busyMax, busy); pending[j.id] = j.res; w.postMessage({ id: j.id, body: j.body }); } stats.maxQueue = Math.max(stats.maxQueue, waiting.length); }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // A client request: network+platform overhead (outside the execution) + queue for a free slot + execution.
  async function call(body) {
    const t0 = Date.now();
    await sleep(cfg.netOverheadMs * S / 2);
    const out = await new Promise(res => { waiting.push({ id: nextId++, body, res }); pump(); });
    await sleep(cfg.netOverheadMs * S / 2);
    return { out, ms: (Date.now() - t0) / S };
  }
  return { call, stats, book, cache, close: () => Promise.all(workers.map(w => w.terminate())), cfg };
}
module.exports = { createEmu };
