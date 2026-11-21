// SAFETY GUARD for anything that talks to a REAL Apps Script URL (only probe-real.js does).
// Refuses: no explicit opt-in, any deployment id that appears in this repository's pages (= the production URL),
// and anything that is not a script.google.com /exec URL.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..', '..');
function productionIds() {
  const ids = new Set();
  fs.readdirSync(ROOT).filter(f => f.endsWith('.html')).forEach(f => { (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/AKfyc[A-Za-z0-9_-]+/g) || []).forEach(x => ids.add(x)); });
  return ids;
}
function assertSafeTarget(url) {
  if (process.env.MK_I_CONFIRM_NOT_PRODUCTION !== 'yes') throw new Error('Refused: set MK_I_CONFIRM_NOT_PRODUCTION=yes (and only for a TEST/LOAD deployment).');
  const m = /^https:\/\/script\.google\.com\/macros\/s\/(AKfyc[A-Za-z0-9_-]+)\/exec$/.exec(String(url || ''));
  if (!m) throw new Error('Refused: not an Apps Script /exec URL.');
  if (productionIds().has(m[1])) throw new Error('Refused: this deployment id is used by the pages in this repository (production).');
  return url;
}
module.exports = { assertSafeTarget, productionIds };
