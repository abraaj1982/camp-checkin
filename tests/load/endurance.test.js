// Sessions over a 5-hour (and longer) camp day with a controllable clock — REAL server code, FICTIONAL data.
// Run: node tests/load/endurance.test.js
const { seed } = require('./lib/seed'); const { chk, done } = require('./lib/report')('endurance');
let off = 0; const RD = Date;
class FD extends RD { constructor(...a) { if (a.length) super(...a); else super(RD.now() + off); } static now() { return RD.now() + off; } }
const H = 3600e3, M = 60e3;
off = 0; const s = seed({ Date: FD });
const at = (ms, u, body) => { off = ms; Object.keys(s.cache).forEach(k => delete s.cache[k]); return s.post(Object.assign({ token: s.tokens[u] }, body)); };
let ok = true; for (let t = 10 * M; t <= 5 * H; t += 10 * M) { const r = at(t, 'sup1', { action: 'roster' }); if (!r.success) { ok = false; break; } }
chk(ok, 'E1 supervisor active every 10 min for 5 h: never logged out');
chk(at(5 * H + 2 * H + 5 * M, 'sup1', { action: 'roster' }).code === 'IDLE_TIMEOUT', 'E2 supervisor idle > 2 h: must log in again (by design)');
chk(at(31 * M, 'secr', { action: 'receptionList' }).code === 'IDLE_TIMEOUT', 'E3 secretariat (sensitive) idle 31 min: must log in again (by design)');
chk(at(29 * M, 'leader', { action: 'leaderAll' }).success, 'E4 leader idle 29 min: still logged in');
chk(/EXPIRED|IDLE_TIMEOUT/.test(at(12 * H + M, 'leader', { action: 'leaderAll' }).code || ''), 'E5 any token after 12 h: expired (by design)');
off = 0; const s2 = seed({ Date: FD }); s2.lockState.fail = true; let kicked = null;
for (let t = 10 * M; t <= 3 * H; t += 10 * M) { off = t; Object.keys(s2.cache).forEach(k => delete s2.cache[k]); const x = s2.post({ action: 'receptionList', token: s2.tokens.secr }); if (!x.success) { kicked = t / M; break; } }
chk(kicked === null, 'E6 [C1] the lock is busy EVERY time for 3 h: an ACTIVE secretariat user stays logged in' + (kicked ? ` — logged out at ${kicked} min` : ''));
done();
