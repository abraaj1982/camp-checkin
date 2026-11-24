// =============================================================
// Custody (phones + luggage) and early withdrawal.
// Phones are kept in sealed clear bags labelled with the student's name.
// Rule: an early withdrawal can be CLOSED only when the phone and all bags are returned.
// No national ID and no signature are collected. No phone numbers are ever returned by this module.
// Required permission: 'custody' (secretariat). Read-only summary also for dashboard/stats/manage.
// =============================================================

const CUSTODY_ITEMS_ = ['phone', 'bags'];
const MAX_CUSTODY_BAGS_ = 20;

function custodySheet_() { return getSheetByName_('Custody'); }
function withdrawalsSheet_() { return getSheetByName_('Withdrawals'); }

// Current holdings per student, derived from the append-only Custody log.
function custodyStates_() {
  const data = custodySheet_().getDataRange().getValues();
  const h = data[0] || [];
  const ix = function(n) { return h.indexOf(n); };
  const states = {}, clients = {};
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][ix('StudentID')]).trim();
    if (!id) continue;
    const cid = String(data[r][ix('ClientId')] || '');
    if (cid) clients[cid] = true;
    const s = states[id] || (states[id] = { phone: false, bags: 0, phoneTag: '' });
    const item = String(data[r][ix('Item')]), act = String(data[r][ix('Action')]);
    const n = Number(data[r][ix('Count')]) || 0;
    if (item === 'phone') { s.phone = act === 'receive'; s.phoneTag = act === 'receive' ? String(data[r][ix('Tag')] || '') : ''; }
    else if (item === 'bags') s.bags = Math.max(0, s.bags + (act === 'receive' ? n : -n));
  }
  return { states: states, clients: clients };
}

function custodyOf_(states, id) { return states[id] || { phone: false, bags: 0, phoneTag: '' }; }

function readWithdrawals_() {
  const v = withdrawalsSheet_().getDataRange().getValues();
  const h = v[0] || [], out = [];
  const iso = function(t) { return t instanceof Date ? t.toISOString() : String(t || ''); };
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id')) continue;
    out.push({ id: String(g('Id')), studentId: String(g('StudentID')), time: iso(g('Time')), guardian: String(g('GuardianName')), reason: String(g('Reason')),
      status: String(g('Status')), by: String(g('CreatedBy')), closedAt: iso(g('ClosedAt')), closedBy: String(g('ClosedBy')), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}

function custodyView_(student, cs, withdrawals) {
  const c = custodyOf_(cs, student.id);
  const open = withdrawals.filter(function(w) { return w.studentId === student.id && w.status === 'open'; })[0];
  return { id: student.id, name: student.name, team: student.team, bus: student.bus, cls: student.cls,
    phone: c.phone, phoneTag: c.phoneTag, bags: c.bags, bagsExpected: student.bags,
    withdrawal: open ? { id: open.id, guardian: open.guardian, reason: open.reason, time: open.time } : null };
}

function handleCustodyFind_(data) {
  return withAuth_(data, requirePerm_('custody'), function() {
    const q = String(data.q === undefined ? '' : data.q).trim().toLowerCase();
    if (q.length < 1 || q.length > 60) return { success: true, results: [] };
    const cs = custodyStates_().states, w = readWithdrawals_();
    const res = readStudents_().students.filter(function(s) { return s.id.toLowerCase() === q || s.id.indexOf(q) === 0 || (q.length >= 2 && s.name.toLowerCase().indexOf(q) !== -1); })
      .slice(0, 8).map(function(s) { return custodyView_(s, cs, w); });
    return { success: true, results: res };
  });
}

function handleCustodyRecord_(data) {
  return withAuth_(data, requirePerm_('custody'), function(user) {
    const item = String(data.item), op = String(data.op);
    if (CUSTODY_ITEMS_.indexOf(item) === -1 || ['receive', 'return'].indexOf(op) === -1) return { success: false, error: 'Invalid request' };
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    let count = 1;
    if (item === 'bags') {
      count = Math.floor(Number(data.count));
      if (!isFinite(count) || count < 1 || count > MAX_CUSTODY_BAGS_) return { success: false, error: 'عدد غير صالح' };
    }
    const tag = String(data.tag || '').trim().slice(0, 30);
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cs = custodyStates_();
      if (clientId && cs.clients[clientId]) return { success: true, repeated: true, custody: custodyView_(student, cs.states, readWithdrawals_()) };
      const cur = custodyOf_(cs.states, student.id);
      if (item === 'phone' && op === 'receive' && cur.phone) return { success: false, code: 'ALREADY_HELD', error: 'الهاتف مستلَم مسبقاً', custody: custodyView_(student, cs.states, readWithdrawals_()) };
      if (item === 'phone' && op === 'return' && !cur.phone) return { success: false, code: 'NOT_HELD', error: 'لا يوجد هاتف مستلَم لهذا الطالب' };
      if (item === 'bags' && op === 'return' && count > cur.bags) return { success: false, code: 'EXCEEDS_HELD', error: 'المُسلَّم أكثر من المستلَم (' + cur.bags + ')', held: cur.bags };
      appendSafe_(custodySheet_(), [new Date(), student.id, item, op, count, tag, user.Username, clientId, String(data.notes || '').slice(0, 200)]);
      const cs2 = custodyStates_();
      return { success: true, custody: custodyView_(student, cs2.states, readWithdrawals_()) };
    } finally {
      lock.releaseLock();
    }
  });
}

// Totals for everyone allowed to see them; the holders list only for custody/manage.
function handleCustodySummary_(data) {
  return withAuth_(data, requireAnyPerm_(['custody', 'manage', 'dashboard', 'stats']), function(user) {
    const cs = custodyStates_().states;
    const students = readStudents_().students;
    const byId = {};
    students.forEach(function(s) { byId[s.id] = s; });
    let phones = 0, bags = 0;
    const holders = [], perBus = {};
    Object.keys(cs).forEach(function(id) {
      const c = cs[id], s = byId[id];
      if (!s || (!c.phone && c.bags === 0)) return;
      if (c.phone) phones++;
      bags += c.bags;
      const pb = perBus[s.bus] || (perBus[s.bus] = { bus: s.bus, phones: 0, bags: 0 });
      if (c.phone) pb.phones++;
      pb.bags += c.bags;
      holders.push({ id: id, name: s.name, team: s.team, bus: s.bus, phone: c.phone, phoneTag: c.phoneTag, bags: c.bags });
    });
    const w = readWithdrawals_();
    const out = { success: true, phones: phones, bags: bags, studentsHolding: holders.length,
      perBus: Object.keys(perBus).sort().map(function(k) { return perBus[k]; }),
      withdrawalsOpen: w.filter(function(x) { return x.status === 'open'; }).length,
      withdrawalsClosed: w.filter(function(x) { return x.status === 'closed'; }).length };
    if (hasPerm_(user, 'custody') || hasPerm_(user, 'manage')) out.holders = holders.slice(0, 400);
    return out;
  });
}

// ---------------- Early withdrawal ----------------
// Undo a CLOSED withdrawal (closed by mistake): the student goes back to the state he had before (boarded / not yet).
function handleWithdrawReopen_(data) {
  return withAuth_(data, requireAnyPerm_(['custody', 'manage']), function(user) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const w = readWithdrawals_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!w) return { success: false, error: 'غير موجود' };
      if (w.status !== 'closed') return { success: false, code: 'NOT_CLOSED', error: 'لا يمكن إعادة طالب لم يُغلق استئذانه' };
      const student = findStudent_(w.studentId);
      const cur = scanStates_().states[w.studentId];
      if (!cur || cur.state !== 'withdrawn') return { success: false, code: 'NOT_WITHDRAWN', error: 'الطالب ليس خارجاً الآن' };
      setWithdrawalStatus_(w._row, 'reversed', user);
      appendSafe_(scansSheet_(), [new Date(), w.studentId, 'readmit', student ? student.bus : '', user.Username, 'custody', '', 'reverses withdrawal ' + w.id]);
      writeAudit_(user.Username, 'WITHDRAW_REVERSED', w.studentId, w.id);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

// Approves an exit (the gate then sees it). Caller holds the script lock.
function openWithdrawalLocked_(student, guardian, reason, user, clientId) {
  const all = readWithdrawals_();
  if (clientId) { const dup = all.filter(function(w) { return w.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
  if (all.some(function(w) { return w.studentId === student.id && w.status === 'open'; })) return { success: false, code: 'ALREADY_OPEN', error: 'يوجد استئذان خروج مفتوح لهذا الطالب' };
  const cur = scanStates_().states[student.id];
  if (cur && cur.state === 'withdrawn') return { success: false, code: 'ALREADY_WITHDRAWN', error: 'خرج مسبقاً' };
  const id = newId_('W');
  appendSafe_(withdrawalsSheet_(), [id, student.id, new Date(), guardian, reason, 'open', user.Username, '', '', clientId]);
  writeAudit_(user.Username, 'WITHDRAW_OPENED', student.id, id);
  return { success: true, id: id };
}

function handleWithdrawStart_(data) {
  return withAuth_(data, requirePerm_('custody'), function(user) {
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const guardian = String(data.guardian || '').trim().slice(0, 60);
    const reason = String(data.reason || '').trim().slice(0, 200);
    if (guardian.length < 2) return { success: false, error: 'اكتب اسم المستلِم' };
    if (reason.length < 3) return { success: false, error: 'اكتب سبب الاستئذان' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const o = openWithdrawalLocked_(student, guardian, reason, user, clientId);
      if (!o.success) return o;
      return { success: true, id: o.id, repeated: o.repeated, custody: custodyView_(student, custodyStates_().states, readWithdrawals_()) };
    } finally {
      lock.releaseLock();
    }
  });
}

function setWithdrawalStatus_(rowNum, status, user) {
  const sheet = withdrawalsSheet_();
  const h = sheet.getDataRange().getValues()[0];
  sheet.getRange(rowNum, h.indexOf('Status') + 1).setValue(status);
  sheet.getRange(rowNum, h.indexOf('ClosedAt') + 1).setValue(new Date());
  sheet.getRange(rowNum, h.indexOf('ClosedBy') + 1).setValue(user.Username);
}

// Shared by the secretariat ("close") and by the gate ("confirm exit"). Caller holds the script lock.
function closeWithdrawalCore_(w, user, method) {
  const student = findStudent_(w.studentId);
  const c = custodyOf_(custodyStates_().states, w.studentId);
  if (c.phone || c.bags > 0) {
    return { success: false, code: 'ITEMS_NOT_RETURNED', error: 'لا يُغلق استئذان الخروج قبل تسليم الهاتف والحقائب',
      outstanding: { phone: c.phone, phoneTag: c.phoneTag, bags: c.bags } };
  }
  setWithdrawalStatus_(w._row, 'closed', user);
  appendSafe_(scansSheet_(), [new Date(), w.studentId, 'withdraw', student ? student.bus : '', user.Username, method, '', 'withdrawal ' + w.id]);
  writeAudit_(user.Username, method === 'gate' ? 'GATE_EXIT' : 'WITHDRAW_CLOSED', w.studentId, w.id);
  return { success: true };
}

function handleWithdrawClose_(data) {
  return withAuth_(data, requirePerm_('custody'), function(user) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const w = readWithdrawals_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!w) return { success: false, error: 'غير موجود' };
      if (w.status !== 'open') return { success: false, code: 'NOT_OPEN', error: 'الطلب ليس مفتوحاً' };
      return closeWithdrawalCore_(w, user, 'custody');
    } finally {
      lock.releaseLock();
    }
  });
}

// ---------------- Gate (scouts on duty) ----------------
// The SECRETARIAT approves a withdrawal (opens it). The scouts at the gate only see approved exits, check the
// student (name / wristband) and confirm that he has left. They never see the reason, never create or approve a withdrawal.
function gateStudent_(s) { return { id: s.id, name: s.name, cls: s.cls, team: s.team, bus: s.bus, photo: s.photo || '' }; }

function handleGateList_(data) {
  return withAuth_(data, requireAnyPerm_(['gate', 'custody', 'manage']), function() {
    const byId = {};
    readStudents_().students.forEach(function(s) { byId[s.id] = s; });
    const all = readWithdrawals_();
    const today = new Date().toISOString().slice(0, 10);
    const mk = function(w) { const s = byId[w.studentId]; return Object.assign(s ? gateStudent_(s) : { id: w.studentId, name: w.studentId, cls: '', team: '', bus: '', photo: '' },
      { wid: w.id, guardian: w.guardian, approvedAt: w.time, approvedBy: w.by, exitedAt: w.closedAt, exitedBy: w.closedBy, medical: w.reason === MED_REASON_ }); };
    return { success: true,
      waiting: all.filter(function(w) { return w.status === 'open'; }).sort(function(a, b) { return a.time < b.time ? -1 : 1; }).map(mk),
      exited: all.filter(function(w) { return w.status === 'closed' && String(w.closedAt).slice(0, 10) === today; }).sort(function(a, b) { return a.closedAt < b.closedAt ? 1 : -1; }).slice(0, 30).map(mk) };
  });
}

// Is THIS student allowed to leave? (used when a scout scans a wristband or types a name)
function handleGateCheck_(data) {
  return withAuth_(data, requireAnyPerm_(['gate', 'custody', 'manage']), function() {
    const q = String(data.q === undefined ? '' : data.q).trim().toLowerCase();
    if (q.length < 1 || q.length > 60) return { success: true, results: [] };
    const all = readWithdrawals_();
    const res = readStudents_().students.filter(function(s) { return s.id.toLowerCase() === q || (q.length >= 2 && s.name.toLowerCase().indexOf(q) !== -1); })
      .slice(0, 6).map(function(s) {
        const open = all.filter(function(w) { return w.studentId === s.id && w.status === 'open'; })[0];
        const done = all.filter(function(w) { return w.studentId === s.id && w.status === 'closed'; }).pop();
        return Object.assign(gateStudent_(s), { exit: open ? 'approved' : (done ? 'exited' : 'none'), wid: open ? open.id : '', guardian: open ? open.guardian : (done ? done.guardian : ''), exitedAt: done ? done.closedAt : '' });
      });
    return { success: true, results: res };
  });
}

function handleGateConfirm_(data) {
  return withAuth_(data, requireAnyPerm_(['gate', 'custody']), function(user) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const w = readWithdrawals_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!w) return { success: false, error: 'غير موجود' };
      if (w.status !== 'open') return { success: false, code: 'NOT_OPEN', error: 'لا يوجد إذن خروج مفتوح لهذا الطالب' };
      return closeWithdrawalCore_(w, user, 'gate');
    } finally {
      lock.releaseLock();
    }
  });
}

function handleWithdrawCancel_(data) {
  return withAuth_(data, requirePerm_('custody'), function(user) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const w = readWithdrawals_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!w) return { success: false, error: 'غير موجود' };
      if (w.status !== 'open') return { success: false, code: 'NOT_OPEN', error: 'الطلب ليس مفتوحاً' };
      setWithdrawalStatus_(w._row, 'cancelled', user);
      writeAudit_(user.Username, 'WITHDRAW_CANCELLED', w.studentId, w.id);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleWithdrawList_(data) {
  return withAuth_(data, requireAnyPerm_(['custody', 'manage', 'dashboard']), function() {
    const cs = custodyStates_().states;
    const byId = {};
    readStudents_().students.forEach(function(s) { byId[s.id] = s; });
    const rank = { open: 0, closed: 1, reversed: 2, cancelled: 3 };
    const list = readWithdrawals_().sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (a.time < b.time ? 1 : -1); }).slice(0, 100).map(function(w) {
      const s = byId[w.studentId] || {}, c = custodyOf_(cs, w.studentId);
      return { id: w.id, studentId: w.studentId, name: s.name || '', team: s.team || '', bus: s.bus || '', time: w.time, guardian: w.guardian, reason: w.reason,
        status: w.status, closedAt: w.closedAt, by: w.by, outstanding: { phone: c.phone, bags: c.bags } };
    });
    return { success: true, withdrawals: list };
  });
}

// ---------------- Medical "no objection" to leaving the camp (doctor -> secretariat -> gate) ----------------
// The doctor only PROPOSES. The secretariat is the single decision point: it approves (which opens the exit, so the gate sees it,
// tagged "medical") or returns it to the doctor with a reason. The gate never sees the doctor's note or any diagnosis.
const MED_REASON_ = 'بتوصية طبية';
function medClearSheet_() { return getSheetByName_('MedClearances'); }
function readMedClear_() {
  const v = medClearSheet_().getDataRange().getValues();
  const h = v[0] || [], out = [];
  const iso = function(t) { return t instanceof Date ? t.toISOString() : String(t || ''); };
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id')) continue;
    out.push({ id: String(g('Id')), studentId: String(g('StudentID')), time: iso(g('Time')), doctor: String(g('DoctorUser')), note: String(g('Note')), status: String(g('Status')),
      handledBy: String(g('HandledBy')), handledAt: iso(g('HandledAt')), returnReason: String(g('ReturnReason')), withdrawalId: String(g('WithdrawalId')), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}
function setMedClear_(rowNum, fields) {
  const sheet = medClearSheet_(), h = sheet.getDataRange().getValues()[0];
  Object.keys(fields).forEach(function(k) { const i = h.indexOf(k); if (i !== -1) sheet.getRange(rowNum, i + 1).setValue(fields[k]); });
}
function handleMedClearCreate_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const note = String(data.note || '').trim().slice(0, 200), clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const all = readMedClear_();
      if (clientId) { const dup = all.filter(function(x) { return x.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
      if (all.some(function(x) { return x.studentId === student.id && x.status === 'pending'; })) return { success: false, code: 'ALREADY_PENDING', error: 'يوجد طلب عدم ممانعة قائم لهذا الطالب' };
      if (readWithdrawals_().some(function(w) { return w.studentId === student.id && w.status === 'open'; })) return { success: false, code: 'ALREADY_OPEN', error: 'يوجد استئذان خروج مفتوح لهذا الطالب' };
      const cur = scanStates_().states[student.id];
      if (cur && cur.state === 'withdrawn') return { success: false, code: 'ALREADY_WITHDRAWN', error: 'خرج مسبقاً' };
      const id = newId_('M');
      appendSafe_(medClearSheet_(), [id, student.id, new Date(), user.Username, note, 'pending', '', '', '', '', clientId]);
      writeAudit_(user.Username, 'MED_CLEARANCE_PROPOSED', student.id, id);
      return { success: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
}
function handleMedClearList_(data) {
  return withAuth_(data, requireAnyPerm_(['medical', 'custody', 'manage']), function() {
    const byId = {}; readStudents_().students.forEach(function(s) { byId[s.id] = s; });
    const rank = { pending: 0, approved: 1, returned: 2 };
    const list = readMedClear_().sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (a.time < b.time ? 1 : -1); }).slice(0, 60).map(function(x) {
      const s = byId[x.studentId] || {};
      return { id: x.id, studentId: x.studentId, name: s.name || x.studentId, team: s.team || '', bus: s.bus || '', time: x.time, doctor: repUserName_(x.doctor), note: x.note, status: x.status,
        handledBy: x.handledBy ? repUserName_(x.handledBy) : '', handledAt: x.handledAt, returnReason: x.returnReason };
    });
    return { success: true, list: list, pending: list.filter(function(x) { return x.status === 'pending'; }).length };
  });
}
function handleMedClearApprove_(data) {
  return withAuth_(data, requirePerm_('custody'), function(user) {
    const guardian = String(data.guardian || '').trim().slice(0, 60);
    if (guardian.length < 2) return { success: false, error: 'اكتب اسم المستلِم' };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const x = readMedClear_().filter(function(y) { return y.id === String(data.id); })[0];
      if (!x) return { success: false, error: 'غير موجود' };
      if (x.status !== 'pending') return { success: false, code: 'NOT_PENDING', error: 'الطلب ليس قائمًا' };
      const student = findStudent_(x.studentId);
      if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
      const o = openWithdrawalLocked_(student, guardian, MED_REASON_, user, '');
      if (!o.success) return o;
      setMedClear_(x._row, { Status: 'approved', HandledBy: user.Username, HandledAt: new Date(), WithdrawalId: o.id });
      writeAudit_(user.Username, 'MED_CLEARANCE_APPROVED', student.id, x.id + '>' + o.id);
      return { success: true, withdrawalId: o.id };
    } finally {
      lock.releaseLock();
    }
  });
}
function handleMedClearReturn_(data) {
  return withAuth_(data, requirePerm_('custody'), function(user) {
    const reason = String(data.reason || '').trim().slice(0, 200);
    if (reason.length < 3) return { success: false, error: 'اكتب سبب الإعادة للطبيب' };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const x = readMedClear_().filter(function(y) { return y.id === String(data.id); })[0];
      if (!x) return { success: false, error: 'غير موجود' };
      if (x.status !== 'pending') return { success: false, code: 'NOT_PENDING', error: 'الطلب ليس قائمًا' };
      setMedClear_(x._row, { Status: 'returned', HandledBy: user.Username, HandledAt: new Date(), ReturnReason: reason });
      writeAudit_(user.Username, 'MED_CLEARANCE_RETURNED', x.studentId, x.id);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}
