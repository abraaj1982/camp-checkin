// Local-only servers for the browser tests:
//  - an API server = the emulator running the REAL server code on FICTIONAL data
//  - a static server for the repository pages (supervisor.html, login.html, ...)
// Both listen on 127.0.0.1 only. Nothing is ever sent to Google.
const http = require('http'), fs = require('fs'), path = require('path');
const { seed } = require('./seed'); const { createEmu } = require('./emu');
const ROOT = path.join(__dirname, '..', '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json' };
const FAST = { open: 20, readBase: 10, readPerKCell: 1, append: 20, set: 10, getRange: 5, cache: 1, props: 1, lock: 1 };
function listen(srv) { return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); }
async function startServers(opts) {
  opts = opts || {};
  const s = seed(opts.seed);
  const emu = createEmu(s, { slots: opts.slots || 10, netOverheadMs: 0, lat: opts.lat || FAST });
  const api = http.createServer((req, res) => {
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end(); }
    if (req.method === 'GET') { res.writeHead(200, h); return res.end(JSON.stringify({ ok: true, service: 'mukhayyam', version: 'emulator' })); } // same shape as doGet
    let b = ''; req.on('data', c => b += c); req.on('end', async () => { let out; try { out = (await emu.call(JSON.parse(b))).out; } catch (e) { out = { success: false, error: 'Server error' }; } res.writeHead(200, h); res.end(JSON.stringify(out)); });
  });
  const web = http.createServer((req, res) => {
    const p = path.normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[\/\\])+/, '');
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  const apiPort = await listen(api), webPort = await listen(web);
  return { s, emu, apiUrl: 'http://127.0.0.1:' + apiPort, webUrl: 'http://127.0.0.1:' + webPort,
    scans: () => s.book.Scans.rows, bags: () => s.book.Bags.rows,
    boards: id => s.book.Scans.rows.filter(r => String(r[1]) === String(id) && r[2] === 'board').length,
    close: async () => { api.close(); web.close(); await emu.close(); } };
}
module.exports = { startServers, FAST };
