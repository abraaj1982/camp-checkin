// Records the answers of 400 random scan operations (board / undo / withdraw, every user type) and compares them
// with a previous recording: proves a server change did NOT change what the app receives.
// Usage: node tests/load/responses.js record before.json   ->  (change code)  ->  node tests/load/responses.js compare before.json
const fs = require('fs'); const { seed } = require('./lib/seed');
function runOps() {
  let x = 12345; const rnd = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
  const s = seed({ students: 40, buses: 2, supervisors: 2 }); const out = []; const users = ['sup1', 'sup2', 'all1', 'admin'];
  const norm = o => JSON.stringify(o).replace(/"at":"[^"]*"/g, '"at":"T"');
  for (let i = 0; i < 400; i++) {
    const u = users[Math.floor(rnd() * users.length)], id = String(1001 + Math.floor(rnd() * 40)), op = ['board', 'board', 'undo', 'withdraw'][Math.floor(rnd() * 4)];
    const method = ['qr', 'qr', 'name', 'guardian', '=cmd'][Math.floor(rnd() * 5)], notes = ['', '', 'ملاحظة', '=SUM(A1)', '+1'][Math.floor(rnd() * 5)];
    out.push(norm(s.post({ action: 'scan', op, token: s.tokens[u], studentId: id, clientId: rnd() < 0.1 && i > 0 ? 'c' + (i - 1) : 'c' + i, method, notes })));
  }
  const rosters = ['sup1', 'sup2'].map(u => norm(s.post({ action: 'roster', token: s.tokens[u] }))).concat([norm(s.post({ action: 'leaderAll', token: s.tokens.admin }).summary)]);
  return { out, rosters, rows: s.book.Scans.rows.length };
}
const [mode, file] = process.argv.slice(2); if (!mode || !file) { console.log('usage: responses.js record|compare <file>'); process.exit(2); }
const now = runOps();
if (mode === 'record') { fs.writeFileSync(file, JSON.stringify(now)); console.log('recorded', now.out.length, 'answers'); }
else {
  const was = JSON.parse(fs.readFileSync(file, 'utf8')); let d = 0;
  now.out.forEach((x, i) => { if (x !== was.out[i]) { d++; if (d < 4) console.log('DIFF #' + i + '\n before:', was.out[i].slice(0, 250), '\n after :', x.slice(0, 250)); } });
  const mix = {}; now.out.forEach(x => { const o = JSON.parse(x); const k = o.code || (o.repeated ? 'repeated' : 'ok'); mix[k] = (mix[k] || 0) + 1; });
  const same = d === 0 && JSON.stringify(now.rosters) === JSON.stringify(was.rosters) && now.rows === was.rows;
  console.log((same ? 'PASS' : 'FAIL') + ` ${now.out.length} answers compared, ${d} different; rosters identical: ${JSON.stringify(now.rosters) === JSON.stringify(was.rosters)}; mix ${JSON.stringify(mix)}`);
  process.exitCode = same ? 0 : 1;
}
