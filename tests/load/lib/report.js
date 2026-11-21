// Tiny result collector: prints PASS/FAIL lines, writes results/<name>.json, exit code 1 on any FAIL.
const fs = require('fs'), path = require('path');
module.exports = function reporter(name) {
  const res = [];
  const chk = (ok, msg) => { res.push({ ok: !!ok, msg }); console.log((ok ? 'PASS ' : 'FAIL ') + msg); };
  const done = () => { const dir = path.join(__dirname, '..', 'results'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(res, null, 1)); const f = res.filter(r => !r.ok).length; console.log(`\n${name}: ${res.length - f}/${res.length} passed`); process.exitCode = f ? 1 : 0; };
  return { chk, done, res };
};
