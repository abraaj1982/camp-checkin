// ============================================================
// MUKHAYYAM — Platform API (v2)
// - Every data read/write requires a valid token (no public endpoints).
// - Students are read by COLUMN NAME from the active student sheet.
// - Attendance, bags and bus status are stored in the MAIN sheet
//   (tabs: Scans, Bags, BusLive) so swapping the student sheet never loses logs.
// ============================================================
const SHEET_ID = 'PUT_YOUR_MAIN_SHEET_ID_HERE'; // المعرّف بين /d/ و /edit في رابط شيت المنصة الرئيسي
const SHEET_NAME = 'Bus';
const API_VERSION = '2.0.0';
const UNDO_WINDOW_MS = 15 * 60 * 1000;
const MAX_BAGS = 20;
const BUS_STATUSES = ['boarding', 'departed', 'onway', 'arrived'];

function getStudentSpreadsheetId_() {
  const id = getSetting_('ActiveStudentSheetId');
  return id || SHEET_ID;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Public GET: health check only. All student data requires a token via POST.
function doGet() {
  return json_({ ok: true, service: 'mukhayyam', version: API_VERSION });
}

const ACTIONS_ = {
  login: function(d) { return handleLogin_(d); },
  createUser: function(d) { return handleCreateUser_(d); },
  listUsers: function(d) { return handleListUsers_(d); },
  resetPassword: function(d) { return handleResetPassword_(d); },
  unlockAccount: function(d) { return handleUnlockAccount_(d); },
  getMyAccess: function(d) { return handleGetMyAccess_(d); },
  getCatalog: function(d) { return handleGetCatalog_(d); },
  updateUserAccess: function(d) { return handleUpdateUserAccess_(d); },
  checkStudentSheet: function(d) { return withAuth_(d, requireAnyPerm_(['manage', 'support']), function() { return { success: true, report: checkStudentSheet_() }; }); },
  roster: function(d) { return handleRoster_(d); },
  lookup: function(d) { return handleLookup_(d); },
  scan: function(d) { return handleScan_(d); },
  busState: function(d) { return handleBusState_(d); },
  busStatus: function(d) { return handleBusStatus_(d); },
  bag: function(d) { return handleBag_(d); },
  busLive: function(d) { return handleBusLive_(d); },
  leaderSummary: function(d) { return handleLeaderSummary_(d); },
  printList: function(d) { return handlePrintList_(d); }
};

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 200000) {
      return json_({ success: false, error: 'Bad request' });
    }
    const data = JSON.parse(e.postData.contents);
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS_, data.action) ? ACTIONS_[data.action] : null;
    if (!fn) return json_({ success: false, error: 'Invalid action' });
    return json_(fn(data));
  } catch (error) {
    Logger.log('doPost error: ' + error + '\n' + (error && error.stack));
    return json_({ success: false, error: 'Server error' }); // never leak internals
  }
}

// Authorize, then run. `fn(user)` returns the response object.
function withAuth_(data, checkFn, fn) {
  const auth = authorize_(data.token, checkFn);
  if (!auth.ok) return { success: false, error: 'غير مصرَّح: ' + auth.reason, code: auth.reason };
  return fn(auth.user);
}

// ---------------- Students: read by COLUMN NAME ----------------
const STUDENT_HEADERS_ = {
  id: ['student id', 'studentid', 'id', 'رقم الطالب'],
  name: ['name', 'student name', 'الاسم', 'اسم الطالب'],
  team: ['team name', 'team', 'الفريق'],
  bus: ['bus number', 'bus', 'الباص', 'رقم الباص'],
  contact: ['contact number', 'contact', 'phone', 'رقم التواصل'],
  cls: ['class', 'grade', 'الصف'],
  photo: ['photo url', 'photo', 'الصورة'],
  shirt: ['shirt size', 'shirt', 'مقاس القميص'],
  bags: ['bags', 'bag count', 'عدد الحقائب']
};
const STUDENT_REQUIRED_ = ['id', 'name', 'bus'];

function findStudentColumns_(headerRow) {
  const norm = headerRow.map(function(h) { return String(h).trim().toLowerCase(); });
  const cols = {};
  Object.keys(STUDENT_HEADERS_).forEach(function(key) {
    cols[key] = -1;
    for (let i = 0; i < norm.length; i++) {
      if (STUDENT_HEADERS_[key].indexOf(norm[i]) !== -1) { cols[key] = i; break; }
    }
  });
  return cols;
}

function readStudents_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('students_v2');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* fall through */ } }
  const sheet = SpreadsheetApp.openById(getStudentSpreadsheetId_()).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('تبويب Bus غير موجود في شيت الطلاب');
  const data = sheet.getDataRange().getValues();
  const cols = findStudentColumns_(data[0] || []);
  const missing = STUDENT_REQUIRED_.filter(function(k) { return cols[k] === -1; });
  if (missing.length > 0) throw new Error('أعمدة ناقصة في تبويب Bus: ' + missing.join(', '));
  const cell = function(row, key) { return cols[key] === -1 ? '' : row[cols[key]]; };
  const students = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][cols.id] || !data[i][cols.name]) continue;
    students.push({
      id: String(cell(data[i], 'id')).trim(),
      name: String(cell(data[i], 'name')).trim(),
      team: String(cell(data[i], 'team') || '').trim(),
      bus: String(cell(data[i], 'bus') || '').trim(),
      cls: String(cell(data[i], 'cls') || '').trim(),
      photo: String(cell(data[i], 'photo') || '').trim(),
      bags: Number(cell(data[i], 'bags')) || 0,
      _row: i + 1
    });
  }
  const result = { students: students, cols: cols };
  try { cache.put('students_v2', JSON.stringify(result), 60); } catch (e) { /* too large: skip cache */ }
  return result;
}

function findStudent_(id) {
  const key = String(id === undefined || id === null ? '' : id).trim();
  if (!key || key.length > 40) return null;
  return readStudents_().students.find(function(s) { return s.id === key; }) || null;
}

function busSupervisorName_(bus) {
  const rows = readSheetAsObjects_(USERS_SHEET).rows;
  const u = rows.find(function(r) { return r.Active === true && String(r.AssignedBus).trim() === String(bus).trim(); });
  return u ? u.FullName : '';
}

// A user may RECORD for a student only if allowed on every bus, or the student is on the user's own bus.
function canRecordFor_(user, student) {
  if (hasPerm_(user, 'allbuses')) return true;
  return hasPerm_(user, 'checkin') && String(user.AssignedBus).trim() !== '' &&
    String(user.AssignedBus).trim() === String(student.bus).trim();
}

// ---------------- Scans (attendance log) ----------------
function scansSheet_() { return getSheetByName_('Scans'); }

// Current state per student, derived from the append-only log.
function scanStates_() {
  const data = scansSheet_().getDataRange().getValues();
  const h = data[0] || [];
  const ix = function(n) { return h.indexOf(n); };
  const iT = ix('Time'), iS = ix('StudentID'), iA = ix('Action'), iB = ix('Bus'), iU = ix('Supervisor'), iC = ix('ClientId');
  const states = {}, clients = {};
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][iS]).trim();
    if (!id) continue;
    const act = String(data[r][iA]);
    const when = data[r][iT] instanceof Date ? data[r][iT] : new Date(data[r][iT]);
    if (iC !== -1 && data[r][iC]) clients[String(data[r][iC])] = { id: id, act: act };
    if (act === 'board') states[id] = { state: 'boarded', at: when, by: data[r][iU], bus: String(data[r][iB]) };
    else if (act === 'withdraw') states[id] = { state: 'withdrawn', at: when, by: data[r][iU], bus: String(data[r][iB]) };
    else if (act === 'undo') delete states[id];
  }
  return { states: states, clients: clients };
}

function fmtTime_(d) { return Utilities.formatDate(d, 'Asia/Muscat', 'HH:mm'); }

function busCounts_(bus, students, states) {
  const mine = students.filter(function(s) { return s.bus === String(bus); });
  const missing = [], boarded = [];
  mine.forEach(function(s) {
    const st = states[s.id];
    if (st && st.state === 'boarded') boarded.push(s); else if (!st || st.state !== 'withdrawn') missing.push(s);
  });
  return { total: mine.length, boarded: boarded.length, missing: missing };
}

function publicStudent_(s, st, withSup) {
  const out = { id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus,
    state: st ? st.state : 'none', at: st && st.at ? fmtTime_(st.at) : '' };
  if (withSup) out.supervisor = busSupervisorName_(s.bus);
  return out;
}

// All students of the caller's bus (or every bus with the allbuses permission).
function handleRoster_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const students = readStudents_().students;
    const all = hasPerm_(user, 'allbuses');
    const bus = all && data.bus ? String(data.bus) : String(user.AssignedBus).trim();
    if (!bus) return { success: false, error: 'لا يوجد باص مخصَّص لحسابك' };
    const states = scanStates_().states;
    const list = students.filter(function(s) { return s.bus === bus; }).map(function(s) {
      const o = publicStudent_(s, states[s.id], false); o.photo = s.photo; o.bagsExpected = s.bags; return o;
    });
    const c = busCounts_(bus, students, states);
    return { success: true, bus: bus, students: list, total: c.total, boarded: c.boarded };
  });
}

// View-only search across ALL buses (never records anything).
function handleLookup_(data) {
  return withAuth_(data, requirePerm_('checkin'), function() {
    const q = String(data.q === undefined ? '' : data.q).trim().toLowerCase();
    if (q.length < 1 || q.length > 60) return { success: true, results: [] };
    const students = readStudents_().students;
    const states = scanStates_().states;
    const res = students.filter(function(s) { return s.id.toLowerCase() === q || s.id.indexOf(q) === 0 || (q.length >= 2 && s.name.toLowerCase().indexOf(q) !== -1); })
      .slice(0, 8).map(function(s) { return publicStudent_(s, states[s.id], true); });
    return { success: true, results: res };
  });
}

function handleScan_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const action = String(data.op); // sub-operation (data.action is the API route)
    if (['board', 'undo', 'withdraw'].indexOf(action) === -1) return { success: false, error: 'Invalid scan action' };
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    // Scope comes from the SHEET's bus for this student, never from the client.
    if (!canRecordFor_(user, student)) {
      return { success: false, code: 'OTHER_BUS', error: 'هذا الطالب ليس في باصك', student: publicStudent_(student, scanStates_().states[student.id], true) };
    }
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sc = scanStates_();
      if (clientId && sc.clients[clientId]) { // retry of an already-applied request: idempotent
        const c0 = busCounts_(student.bus, readStudents_().students, sc.states);
        return { success: true, repeated: true, student: publicStudent_(student, sc.states[student.id], false), boarded: c0.boarded, total: c0.total };
      }
      const cur = sc.states[student.id];
      if (action === 'board') {
        if (cur && cur.state === 'boarded') return { success: false, code: 'DUPLICATE', error: 'مسجَّل صعوده مسبقاً', at: fmtTime_(cur.at), student: publicStudent_(student, cur, false) };
        if (cur && cur.state === 'withdrawn') return { success: false, code: 'WITHDRAWN', error: 'الطالب منسحب', student: publicStudent_(student, cur, false) };
      }
      if (action === 'undo') {
        if (!cur || cur.state !== 'boarded') return { success: false, code: 'NOTHING_TO_UNDO', error: 'لا يوجد تسجيل للتراجع عنه' };
        if (!hasPerm_(user, 'allbuses') && (Date.now() - cur.at.getTime()) > UNDO_WINDOW_MS) return { success: false, code: 'UNDO_EXPIRED', error: 'انتهت مهلة التراجع' };
      }
      if (action === 'withdraw' && cur && cur.state === 'withdrawn') return { success: false, code: 'ALREADY_WITHDRAWN', error: 'منسحب مسبقاً' };
      scansSheet_().appendRow([new Date(), student.id, action, student.bus, user.Username, String(data.method || '').slice(0, 20), clientId, String(data.notes || '').slice(0, 200)]);
      if (action === 'undo') writeAudit_(user.Username, 'SCAN_UNDO', student.id, 'bus=' + student.bus);
      const sc2 = scanStates_();
      const c = busCounts_(student.bus, readStudents_().students, sc2.states);
      return { success: true, student: publicStudent_(student, sc2.states[student.id], false), boarded: c.boarded, total: c.total };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleBusState_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const bus = hasPerm_(user, 'allbuses') && data.bus ? String(data.bus) : String(user.AssignedBus).trim();
    const students = readStudents_().students;
    const states = scanStates_().states;
    const c = busCounts_(bus, students, states);
    return { success: true, bus: bus, total: c.total, boarded: c.boarded,
      missing: c.missing.map(function(s) { return { id: s.id, name: s.name, team: s.team }; }) };
  });
}

// ---------------- Bus status + location (BusLive: one row per bus) ----------------
function busLiveSheet_() { return getSheetByName_('BusLive'); }

function handleBusStatus_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const bus = String(user.AssignedBus).trim();
    if (!bus) return { success: false, error: 'لا يوجد باص مخصَّص لحسابك' };
    const status = data.status ? String(data.status) : '';
    if (status && BUS_STATUSES.indexOf(status) === -1) return { success: false, error: 'Invalid status' };
    const lat = Number(data.lat), lng = Number(data.lng);
    const hasGeo = isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && data.lat !== undefined && data.lat !== null;
    const students = readStudents_().students;
    const c = busCounts_(bus, students, scanStates_().states);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = busLiveSheet_();
      const vals = sheet.getDataRange().getValues();
      const h = vals[0];
      let row = -1;
      for (let r = 1; r < vals.length; r++) if (String(vals[r][h.indexOf('Bus')]) === bus) { row = r + 1; break; }
      const prev = row === -1 ? {} : {
        Status: vals[row - 1][h.indexOf('Status')], Lat: vals[row - 1][h.indexOf('Lat')], Lng: vals[row - 1][h.indexOf('Lng')], Accuracy: vals[row - 1][h.indexOf('Accuracy')]
      };
      const rec = {
        Bus: bus, Status: status || prev.Status || 'boarding',
        Lat: hasGeo ? lat : (prev.Lat || ''), Lng: hasGeo ? lng : (prev.Lng || ''), Accuracy: hasGeo ? (Number(data.acc) || '') : (prev.Accuracy || ''),
        UpdatedAt: new Date(), Supervisor: user.FullName, Boarded: c.boarded, Total: c.total
      };
      const out = h.map(function(n) { return rec.hasOwnProperty(n) ? rec[n] : ''; });
      if (row === -1) sheet.appendRow(out); else sheet.getRange(row, 1, 1, out.length).setValues([out]);
      if (status === 'departed') writeAudit_(user.Username, 'BUS_DEPARTED', bus, 'boarded=' + c.boarded + '/' + c.total);
    } finally {
      lock.releaseLock();
    }
    return { success: true, boarded: c.boarded, total: c.total, missing: c.missing.length };
  });
}

function handleBusLive_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'livemap']), function() {
    const vals = busLiveSheet_().getDataRange().getValues();
    const h = vals[0];
    const now = Date.now();
    const buses = [];
    for (let r = 1; r < vals.length; r++) {
      const g = function(n) { return vals[r][h.indexOf(n)]; };
      if (!g('Bus')) continue;
      const upd = g('UpdatedAt') instanceof Date ? g('UpdatedAt') : new Date(g('UpdatedAt'));
      buses.push({ bus: String(g('Bus')), status: g('Status'), lat: g('Lat') === '' ? null : Number(g('Lat')), lng: g('Lng') === '' ? null : Number(g('Lng')),
        ageSec: Math.max(0, Math.round((now - upd.getTime()) / 1000)), supervisor: g('Supervisor'), boarded: Number(g('Boarded')) || 0, total: Number(g('Total')) || 0 });
    }
    return { success: true, buses: buses };
  });
}

// ---------------- Bags (airport idea: load / unload counts) ----------------
function bagsSheet_() { return getSheetByName_('Bags'); }

function handleBag_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const mode = String(data.mode);
    if (['load', 'unload'].indexOf(mode) === -1) return { success: false, error: 'Invalid mode' };
    const count = Math.floor(Number(data.count));
    if (!isFinite(count) || count < 0 || count > MAX_BAGS) return { success: false, error: 'عدد غير صالح' };
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    if (!canRecordFor_(user, student)) return { success: false, code: 'OTHER_BUS', error: 'هذا الطالب ليس في باصك' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = bagsSheet_();
      const vals = sheet.getDataRange().getValues();
      const h = vals[0];
      const iC = h.indexOf('ClientId');
      if (clientId) for (let r = 1; r < vals.length; r++) if (String(vals[r][iC]) === clientId) return { success: true, repeated: true };
      sheet.appendRow([new Date(), student.id, student.bus, mode, count, student.bags, user.Username, clientId]);
    } finally {
      lock.releaseLock();
    }
    return { success: true, expected: student.bags, mismatch: student.bags > 0 && mode === 'load' && count < student.bags };
  });
}

// ---------------- Leader summary (read-only) ----------------
function handleLeaderSummary_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'stats']), function() {
    const students = readStudents_().students;
    const sc = scanStates_();
    const buses = {};
    students.forEach(function(s) { buses[s.bus] = true; });
    const perBus = Object.keys(buses).sort().map(function(b) {
      const c = busCounts_(b, students, sc.states);
      return { bus: b, total: c.total, boarded: c.boarded, missing: c.missing.length };
    });
    let withdrawn = 0;
    Object.keys(sc.states).forEach(function(k) { if (sc.states[k].state === 'withdrawn') withdrawn++; });
    const total = students.length;
    const boarded = perBus.reduce(function(a, b) { return a + b.boarded; }, 0);
    // bags
    const bvals = bagsSheet_().getDataRange().getValues();
    const bh = bvals[0];
    let loaded = 0, unloaded = 0;
    const lastByKey = {};
    for (let r = 1; r < bvals.length; r++) lastByKey[bvals[r][bh.indexOf('StudentID')] + '|' + bvals[r][bh.indexOf('Mode')]] = Number(bvals[r][bh.indexOf('Count')]) || 0;
    Object.keys(lastByKey).forEach(function(k) { if (k.split('|')[1] === 'load') loaded += lastByKey[k]; else unloaded += lastByKey[k]; });
    return { success: true, total: total, boarded: boarded, withdrawn: withdrawn, perBus: perBus, bags: { loaded: loaded, unloaded: unloaded } };
  });
}

// ---------------- Print data (wristbands + paper lists): no phone numbers ----------------
function handlePrintList_(data) {
  return withAuth_(data, requireAnyPerm_(['manage', 'print']), function(user) {
    const students = readStudents_().students.map(function(s) {
      return { id: s.id, name: s.name, team: s.team, bus: s.bus, cls: s.cls };
    });
    writeAudit_(user.Username, 'PRINT_LIST', '', 'count=' + students.length);
    return { success: true, students: students };
  });
}

// ---------------- Student-sheet check ("فحص الشيت") ----------------
function checkStudentSheet_() {
  const report = { ok: true, problems: [], notes: [] };
  let result;
  try {
    CacheService.getScriptCache().remove('students_v2');
    result = readStudents_();
  } catch (err) {
    report.ok = false;
    report.problems.push(String(err.message || err));
    return report;
  }
  const seen = {}, perBus = {}, dups = [], noBus = [];
  result.students.forEach(function(st) {
    if (seen[st.id]) dups.push(st.id); seen[st.id] = true;
    if (!st.bus) noBus.push('صف ' + st._row);
    perBus[st.bus || '—'] = (perBus[st.bus || '—'] || 0) + 1;
  });
  if (dups.length) { report.ok = false; report.problems.push('أرقام طلاب مكررة: ' + dups.join(', ')); }
  if (noBus.length) { report.ok = false; report.problems.push('طلاب بلا باص: ' + noBus.join(', ')); }
  if (result.cols.cls === -1) report.notes.push('عمود Class غير موجود (اختياري)');
  if (result.cols.photo === -1) report.notes.push('عمود Photo URL غير موجود (لازم للتعرف على الوجه)');
  if (result.cols.team === -1) report.notes.push('عمود Team name غير موجود (لازم للأساور)');
  report.total = result.students.length;
  report.perBus = perBus;
  return report;
}

function ADMIN_checkStudentSheet() {
  Logger.log(JSON.stringify(checkStudentSheet_(), null, 2));
}
