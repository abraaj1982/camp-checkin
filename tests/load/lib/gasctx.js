// Loads the REAL server code (server/*.gs) into an isolated vm context with fake Google services.
// Nothing here can reach Google: SpreadsheetApp/CacheService/LockService/PropertiesService are all local fakes.
const vm = require('vm'), fs = require('fs'), crypto = require('crypto');
const SRC = (process.env.MK_SERVER_DIR || require('path').join(__dirname, '..', '..', '..', 'server')) + '/'; // MK_SERVER_DIR: compare another version of the code
const FILES = ['Auth', 'Code', 'Custody', 'Health', 'Media', 'Shirts', 'Reports', 'Reception'];
let CODE = FILES.map(f => fs.readFileSync(SRC + f + '.gs', 'utf8')).join('\n');
const SCRIPT = new vm.Script(CODE, { filename: 'server.gs' });
const Utilities = {
  computeHmacSha256Signature: (a, b) => [...crypto.createHmac('sha256', Buffer.from(typeof b === 'string' ? b : b.map(x => x & 255))).update(typeof a === 'string' ? Buffer.from(a) : Buffer.from(a.map(x => x & 255))).digest()].map(x => x > 127 ? x - 256 : x),
  newBlob: s => ({ getBytes: () => [...Buffer.from(s)].map(x => x > 127 ? x - 256 : x), getDataAsString: () => Array.isArray(s) ? Buffer.from(s.map(x => x & 255)).toString() : s }),
  base64EncodeWebSafe: b => Buffer.from(b.map(x => x & 255)).toString('base64url'), base64DecodeWebSafe: s => [...Buffer.from(s, 'base64url')].map(x => x > 127 ? x - 256 : x),
  base64Encode: b => Buffer.from((Array.isArray(b) ? b : [...Buffer.from(b)]).map(x => x & 255)).toString('base64'), base64Decode: s => [...Buffer.from(s, 'base64')].map(x => x > 127 ? x - 256 : x),
  computeDigest: (a, seed) => [...crypto.createHash('sha256').update(seed).digest()], DigestAlgorithm: { SHA_256: 1 }, getUuid: () => crypto.randomUUID(),
  formatDate: (d, tz, f) => { const x = new Date(d.getTime() + 4 * 3600e3); return f === 'yyyy-MM-dd' ? x.toISOString().slice(0, 10) : String(x.getUTCHours()).padStart(2, '0') + ':' + String(x.getUTCMinutes()).padStart(2, '0'); }
};
function makeCtx(svc) {
  const ctx = Object.assign({ console, Logger: { log: () => {} }, Date, Utilities,
    ContentService: { createTextOutput: t => ({ t, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
    UrlFetchApp: { fetch: () => { const days = []; for (let i = 0; i < 16; i++) days.push(new Date(Date.now() + i * 86400000).toISOString().slice(0, 10)); // a fixed fake forecast: nothing here reaches the internet
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ daily: { time: days, weather_code: days.map((d, i) => (i === 2 ? 61 : i % 3)), temperature_2m_max: days.map(() => 27.4), temperature_2m_min: days.map(() => 15.6), precipitation_probability_max: days.map((d, i) => (i === 2 ? 60 : 8)), precipitation_sum: days.map((d, i) => (i === 2 ? 6 : 0)), wind_speed_10m_max: days.map(() => 16) } }) }; } },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create() {} }) }) }) } }, svc);
  vm.createContext(ctx); SCRIPT.runInContext(ctx); return ctx;
}
module.exports = { makeCtx, vm };
