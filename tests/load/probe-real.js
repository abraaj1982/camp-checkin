// OPTIONAL real-platform probe (read-only). Sends ONLY requests that write nothing: an invalid token, and a login
// with a username that does not exist. Guarded: refuses production (any deployment id used by this repo's pages).
// Usage: MK_I_CONFIRM_NOT_PRODUCTION=yes node tests/load/probe-real.js https://script.google.com/macros/s/<TEST_OR_LOAD_ID>/exec [concurrency]
const { assertSafeTarget } = require('./guard');
const url = assertSafeTarget(process.argv[2]); const N = Math.min(100, Number(process.argv[3]) || 30);
const one = async body => { const t = Date.now(); try { const r = await fetch(url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' }); const j = await r.json(); return { ms: Date.now() - t, ok: j && j.success === false }; } catch (e) { return { ms: Date.now() - t, ok: false }; } };
const pct = (a, q) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
(async () => {
  for (const [label, body] of [['no sheet access (invalid token)', { action: 'roster', token: 'x.y' }], ['reads Users (unknown username)', { action: 'login', username: 'zz_probe_nouser', password: 'x' }]]) {
    const r = await Promise.all(Array.from({ length: N }, () => one(body))); const ms = r.map(x => x.ms);
    console.log(`${label}: ${N} at once -> answered correctly ${r.filter(x => x.ok).length}/${N}, p50 ${pct(ms, .5)} ms, p90 ${pct(ms, .9)} ms, max ${Math.max(...ms)} ms`);
  }
})();
