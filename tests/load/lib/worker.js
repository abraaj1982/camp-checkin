// One Apps Script "execution slot": runs the REAL server code; every Sheets/Cache/Lock/Properties call is a
// blocking RPC to the main thread (which owns the shared data, the single script lock and the latency model).
const { parentPort, workerData, receiveMessageOnPort } = require('worker_threads');
const { makeCtx } = require('./gasctx');
const flag = new Int32Array(workerData.sab);
const port = workerData.port;
let held = false, curAction = '';
function rpc(op, a) {
  port.postMessage({ op, a, act: curAction });
  Atomics.wait(flag, 0, 0); Atomics.store(flag, 0, 0);
  const m = receiveMessageOnPort(port).message;
  if (m && m.__err) throw new Error(m.__err);
  return m;
}
function sheetProxy(n) {
  return { getDataRange: () => ({ getValues: () => rpc('read', [n]) }), getLastRow: () => rpc('lastRow', [n]), getLastColumn: () => rpc('lastCol', [n]),
    appendRow: r => rpc('append', [n, r]), getName: () => n, setFrozenRows() {},
    getRange: (r, c, nr = 1, nc = 1) => ({ setValue: v => rpc('setValues', [n, r, c, [[v]]]), setValues: vs => rpc('setValues', [n, r, c, vs]), getValues: () => rpc('getRange', [n, r, c, nr, nc]), getValue: () => rpc('getRange', [n, r, c, 1, 1])[0][0] }) };
}

const svc = {
  SpreadsheetApp: { openById: () => { rpc('open', []); return { getSheetByName: n => rpc('has', [n]) ? sheetProxy(n) : null, getName: () => 'x' }; } },
  CacheService: { getScriptCache: () => ({ get: k => rpc('cget', [k]), put: (k, v, t) => rpc('cput', [k, v, t]), remove: k => rpc('cdel', [[k]]), removeAll: ks => rpc('cdel', [ks]) }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => rpc('pget', [k]), setProperty: (k, v) => rpc('pset', [k, v]), deleteProperty: k => rpc('pset', [k, null]) }) },
  LockService: { getScriptLock: () => ({ waitLock: ms => { rpc('lock', [ms, curAction]); held = true; }, tryLock: ms => { try { rpc('lock', [ms, curAction]); held = true; return true; } catch (e) { return false; } }, releaseLock: () => { if (held) { held = false; rpc('unlock', []); } } }) }
};
parentPort.on('message', job => {
  const t0 = Date.now(); let out; curAction = String(job.body.action);
  try { const ctx = makeCtx(svc); out = JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(job.body) } }).t); }
  catch (e) { out = { success: false, error: 'EXEC: ' + e.message }; }
  if (held) { held = false; rpc('unlock', []); } // Apps Script releases the lock when the execution ends
  parentPort.postMessage({ id: job.id, out, ms: Date.now() - t0 });
});
