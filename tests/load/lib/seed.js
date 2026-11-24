// Builds an in-memory "book" with the REAL server code and FICTIONAL data only (300 students, 8 buses, ~25 users).
const { makeCtx, vm } = require('./gasctx');
// FICTIONAL data only: invented names (all end with 'التجريبي'), fake phone 99990000, in-memory sheets.
function mkSheet(rows) { return { rows, getDataRange: () => ({ getValues: () => rows.map(r => r.slice()) }), getLastRow: () => rows.length, getLastColumn: () => Math.max(...rows.map(r => r.length), 1), appendRow: r => rows.push(r), getName: () => '', setFrozenRows() {},
  getRange: (r, c, nr = 1, nc = 1) => ({ setValue: v => { rows[r - 1] = rows[r - 1] || []; rows[r - 1][c - 1] = v; }, setValues: vs => vs.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] || []; row.forEach((v, j) => rows[r - 1 + i][c - 1 + j] = v); }), getValues: () => { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? ''); o.push(row); } return o; }, getValue: () => (rows[r - 1] || [])[c - 1] ?? '' }) }; }
function seed(opts) {
  opts = Object.assign({ students: 300, buses: 8, supervisors: 8, photoLen: 0 }, opts || {});
  const book = {}, props = {}, cache = {};
  const ss = { getSheetByName: n => book[n] || null, insertSheet: n => (book[n] = mkSheet([[]])), getName: () => 'x' };
  const lockState = { fail: false };
  const ctx = makeCtx({ Date: opts.Date || Date, SpreadsheetApp: { openById: () => ss },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; }, removeAll: ks => ks.forEach(k => { delete cache[k]; }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() { if (lockState.fail) throw new Error('Lock timeout'); }, tryLock: () => !lockState.fail, releaseLock() {} }) } });
  const U = ['Username', 'PasswordHash', 'Salt', 'FullName', 'Role', 'AssignedBus', 'Active', 'FailedAttempts', 'LockedUntil', 'TokenEpoch', 'LastActivityAt', 'CreatedAt', 'LastLogin'];
  book.Users = mkSheet([U]); book.Settings = mkSheet([['Key', 'Value']]); book.AuditLog = mkSheet([['Timestamp', 'ActorUsername', 'Action', 'TargetUsername', 'Details']]);
  const first = ['محمد', 'أحمد', 'علي', 'حسن', 'حسين', 'يوسف', 'إبراهيم', 'عبدالله', 'خالد', 'سالم', 'سعيد', 'ناصر', 'مصطفى', 'مهدي', 'صادق', 'جعفر', 'باقر', 'عباس', 'زيد', 'عمر'];
  const rows = [['Class', 'Name', 'Bus number', 'Student ID', 'Team name', 'Contact number', 'Photo URL', 'Food allergy', 'Shirt size', 'Bags', 'Medical notes']];
  for (let i = 0; i < opts.students; i++) rows.push([String(5 + i % 4), first[i % 20] + ' ' + first[(i * 3 + 1) % 20] + ' ' + first[(i * 7 + 3) % 20] + ' التجريبي', String(1 + i % opts.buses), String(1001 + i), ['الأزرق', 'الأحمر', 'الأخضر', 'الأصفر'][i % 4], '99990000', opts.photoLen ? 'https://drive.google.com/uc?export=view&id=' + 'x'.repeat(opts.photoLen) : '', i % 9 === 0 ? 'فول سوداني' : '', ['S', 'M', 'L', 'XL'][i % 4], i % 3 === 0 ? 0 : 1, i % 15 === 0 ? 'ربو خفيف' : '']);
  book.Bus = mkSheet(rows);
  const post = o => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(o) } }).t);
  ctx.SETUP_createTabs();
  if (opts.bare) { // fresh deployment: tabs exist, NO users yet (for rehearsing the real LOAD setup, which bootstraps its own admin)
    return { ctx, post, lockState, cache, book, props, tokens: {}, students: rows.slice(1).map(r => ({ id: r[3], bus: r[2], bags: r[9] })), mkSheet, bootstrapSecret: () => vm.runInContext('getBootstrapSecret_()', ctx) };
  }
  post({ action: 'createUser', username: 'admin', password: 'load-test-1', fullName: 'مدير تجريبي', bootstrapSecret: vm.runInContext('getBootstrapSecret_()', ctx) });
  const T = post({ action: 'login', username: 'admin', password: 'load-test-1' }).token;
  const users = [];
  const mk = (u, role, bus, perms) => { const r = post({ action: 'createUser', token: T, username: u, password: 'load-test-1', fullName: 'مستخدم ' + u, role, assignedBus: bus || '', permissions: perms, committees: [] }); if (!r.success) throw new Error(u + ' ' + r.error); users.push(u); };
  for (let i = 1; i <= opts.supervisors; i++) mk('sup' + i, 'supervisor', String(1 + (i - 1) % opts.buses));
  mk('all1', 'supervisor', '', ['checkin', 'allbuses']); mk('all2', 'supervisor', '', ['checkin', 'allbuses']);
  mk('leader', 'camp_leader', '', ['dashboard', 'stats', 'allbuses']); mk('leader2', 'camp_leader', '', ['dashboard', 'stats']);
  mk('secr', 'supervisor', '', ['reports', 'custody', 'print', 'reception', 'addstudent']); mk('doctor', 'supervisor', '', ['medical']); mk('nutri', 'supervisor', '', ['nutrition']);
  mk('scout', 'supervisor', '', ['gate']); mk('media', 'supervisor', '', ['announce', 'results', 'verify']); mk('shirt', 'supervisor', '', ['shirts']);
  for (let i = 1; i <= 6; i++) mk('viewer' + i, 'camp_leader', '', ['dashboard', 'stats']);
  const tokens = {}; users.concat(['admin']).forEach(u => { tokens[u] = post({ action: 'login', username: u, password: 'load-test-1' }).token; });
  post({ action: 'nutritionSetStaff', token: T, count: 30 });
  const feedKey = ctx.ADMIN_createFeedKey();
  if (!opts.keepCache) Object.keys(cache).forEach(k => delete cache[k]);
  return { ctx, post, lockState, cache, book, props, tokens, feedKey, students: rows.slice(1).map(r => ({ id: r[3], bus: r[2], bags: r[9] })), mkSheet };
}
module.exports = { seed, mkSheet };
