// =============================================================
// Shirt distribution (students + staff). Simple on purpose:
// - Each person's SIZE comes from registration (student sheet column "Shirt size"; tab "Staff" for staff).
// - Stock per size is typed in tab "ShirtStock" (or from the screen). Remaining = stock - given.
// - Every hand-over is one row in "ShirtLog" (undo = mark the row undone).
// =============================================================
const SHIRT_STOCK_ = 'ShirtStock', SHIRT_LOG_ = 'ShirtLog', STAFF_SHEET_ = 'Staff';

function normSize_(v) { return String(v === undefined || v === null ? '' : v).trim().toUpperCase().replace(/\s+/g, ''); }

function readStaff_() {
  const out = [];
  let rows = [];
  try { rows = readSheetAsObjects_(STAFF_SHEET_).rows; } catch (e) { rows = []; }
  rows.forEach(function(r) {
    const name = String(r.Name || '').trim(); if (!name) return;
    out.push({ id: 'ST' + r._rowNumber, name: name, size: normSize_(r.Size), note: String(r.Note || '').trim(), kind: 'staff' });
  });
  return out;
}
function readShirtLog_() {
  let rows = [];
  try { rows = readSheetAsObjects_(SHIRT_LOG_).rows; } catch (e) { rows = []; }
  return rows.filter(function(r) { return r.Id; }).map(function(r) {
    return { id: String(r.Id), time: isoOf_(r.Time), kind: String(r.Kind), personId: String(r.PersonId), name: String(r.Name), size: normSize_(r.Size), by: String(r.GivenBy), status: String(r.Status), clientId: String(r.ClientId || ''), _row: r._rowNumber };
  });
}
function readShirtStock_() {
  const out = {};
  let rows = [];
  try { rows = readSheetAsObjects_(SHIRT_STOCK_).rows; } catch (e) { rows = []; }
  rows.forEach(function(r) {
    const s = normSize_(r.Size); if (!s) return;
    out[s] = { total: Math.max(0, Math.floor(Number(r.Total) || 0)), lowAt: Math.max(0, Math.floor(Number(r.LowAt) || 0)), _row: r._rowNumber };
  });
  return out;
}
function shirtPeople_() {
  const st = readStudents_().students.map(function(s) { return { id: s.id, name: s.name, team: s.team, bus: s.bus, size: normSize_(s.shirt), kind: 'student' }; });
  return st.concat(readStaff_());
}
function activeGiven_(log) { const m = {}; log.filter(function(l) { return l.status === 'given'; }).forEach(function(l) { m[l.kind + ':' + l.personId] = l; }); return m; }

// Per size: stock, demand (registered), given, remaining.
function shirtTable_(people, log, stock) {
  const sizes = {}, ensure = function(s) { if (s && !sizes[s]) sizes[s] = { size: s, total: 0, lowAt: 0, demand: 0, given: 0 }; return sizes[s]; };
  Object.keys(stock).forEach(function(s) { const r = ensure(s); r.total = stock[s].total; r.lowAt = stock[s].lowAt; });
  people.forEach(function(p) { if (p.size) ensure(p.size).demand++; });
  log.filter(function(l) { return l.status === 'given'; }).forEach(function(l) { if (l.size) ensure(l.size).given++; });
  const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', 'XXXL', '4XL', '5XL'];
  return Object.keys(sizes).map(function(k) { const r = sizes[k]; r.remaining = r.total - r.given; r.status = r.total === 0 ? 'nostock' : r.remaining <= 0 ? 'out' : (r.lowAt ? r.remaining <= r.lowAt : r.remaining <= Math.max(2, Math.ceil(r.total * 0.1))) ? 'low' : 'ok'; return r; })
    .sort(function(a, b) { const ia = order.indexOf(a.size), ib = order.indexOf(b.size); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.size.localeCompare(b.size); });
}
function shirtSummary_(people, log) {
  const g = activeGiven_(log), c = { students: 0, studentsGiven: 0, staff: 0, staffGiven: 0, noSize: 0 };
  people.forEach(function(p) { if (p.kind === 'student') { c.students++; if (g['student:' + p.id]) c.studentsGiven++; } else { c.staff++; if (g['staff:' + p.id]) c.staffGiven++; } if (!p.size) c.noSize++; });
  return c;
}

function handleShirtStock_(data) {
  return withAuth_(data, requireAnyPerm_(['shirts', 'manage']), function() {
    const people = shirtPeople_(), log = readShirtLog_();
    return { success: true, table: shirtTable_(people, log, readShirtStock_()), summary: shirtSummary_(people, log) };
  });
}

function handleShirtFind_(data) {
  return withAuth_(data, requireAnyPerm_(['shirts']), function() {
    const q = String(data.q || '').trim().toLowerCase();
    if (!q) return { success: true, results: [] };
    const people = shirtPeople_(), given = activeGiven_(readShirtLog_());
    const res = people.filter(function(p) { return String(p.id).toLowerCase() === q || String(p.name).toLowerCase().indexOf(q) !== -1; }).slice(0, 25)
      .map(function(p) { const g = given[p.kind + ':' + p.id]; return { id: p.id, name: p.name, team: p.team || '', bus: p.bus || '', kind: p.kind, size: p.size, given: !!g, givenAt: g ? g.time : '', givenBy: g ? g.by : '', givenSize: g ? g.size : '' }; });
    return { success: true, results: res };
  });
}

function handleShirtGive_(data) {
  return withAuth_(data, requirePerm_('shirts'), function(user) {
    const kind = data.kind === 'staff' ? 'staff' : 'student', id = String(data.id || '').trim();
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const person = shirtPeople_().filter(function(p) { return p.kind === kind && p.id === id; })[0];
      if (!person) return { success: false, code: 'NOT_FOUND', error: 'غير موجود' };
      const log = readShirtLog_();
      if (clientId) { const dup = log.filter(function(l) { return l.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
      const exist = activeGiven_(log)[kind + ':' + id];
      if (exist) return { success: false, code: 'ALREADY_GIVEN', error: 'استلم القميص مسبقاً', givenAt: exist.time, givenBy: exist.by, size: exist.size };
      const size = normSize_(data.size) || person.size;
      if (!size) return { success: false, code: 'NO_SIZE', error: 'لا يوجد مقاس مسجّل. اختر المقاس' };
      const t = shirtTable_(shirtPeople_(), log, readShirtStock_()).filter(function(r) { return r.size === size; })[0];
      if (!t || t.total === 0) return { success: false, code: 'NO_STOCK_ROW', error: 'لم يُسجَّل مخزون لهذا المقاس', size: size };
      if (t.remaining <= 0) return { success: false, code: 'OUT_OF_STOCK', error: 'نفد المقاس ' + size, size: size };
      const lid = newId_('SH');
      getSheetByName_(SHIRT_LOG_).appendRow([lid, new Date(), kind, id, person.name, size, user.Username, 'given', '', clientId]);
      writeAudit_(user.Username, 'SHIRT_GIVEN', id, kind + ' ' + size);
      return { success: true, id: lid, size: size, remaining: t.remaining - 1, changedSize: size !== person.size };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleShirtUndo_(data) {
  return withAuth_(data, requirePerm_('shirts'), function(user) {
    const kind = data.kind === 'staff' ? 'staff' : 'student', id = String(data.id || '').trim();
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cur = activeGiven_(readShirtLog_())[kind + ':' + id];
      if (!cur) return { success: false, code: 'NOT_GIVEN', error: 'لم يُسجَّل تسليم' };
      const sh = getSheetByName_(SHIRT_LOG_), h = sh.getDataRange().getValues()[0];
      sh.getRange(cur._row, h.indexOf('Status') + 1).setValue('undone');
      writeAudit_(user.Username, 'SHIRT_UNDONE', id, kind + ' ' + cur.size);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleShirtStockSet_(data) {
  return withAuth_(data, requireAnyPerm_(['shirts', 'manage']), function(user) {
    const size = normSize_(data.size), total = Math.floor(Number(data.total)), lowAt = data.lowAt === undefined || data.lowAt === '' ? 0 : Math.floor(Number(data.lowAt));
    if (!size || size.length > 8) return { success: false, error: 'اكتب المقاس' };
    if (!isFinite(total) || total < 0 || total > 100000 || !isFinite(lowAt) || lowAt < 0) return { success: false, error: 'رقم غير صالح' };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cur = readShirtStock_()[size], sh = getSheetByName_(SHIRT_STOCK_);
      if (cur) { const h = sh.getDataRange().getValues()[0]; sh.getRange(cur._row, h.indexOf('Total') + 1).setValue(total); sh.getRange(cur._row, h.indexOf('LowAt') + 1).setValue(lowAt); }
      else sh.appendRow([size, total, lowAt]);
      writeAudit_(user.Username, 'SHIRT_STOCK_SET', size, String(total));
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}
