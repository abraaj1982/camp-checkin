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
const UNDO_WINDOW_MS = 2 * 60 * 1000; // a bus supervisor may correct only his LAST record, within 2 minutes
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
  pwHelpRequest: function(d) { return handlePwHelpRequest_(d); },
  pwHelpList: function(d) { return handlePwHelpList_(d); },
  pwHelpDone: function(d) { return handlePwHelpDone_(d); },
  unlockAccount: function(d) { return handleUnlockAccount_(d); },
  setUserActive: function(d) { return handleSetUserActive_(d); },
  updateUserProfile: function(d) { return handleUpdateUserProfile_(d); },
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
  trackPing: function(d) { return handleTrackPing_(d); },
  trackPingCheck: function(d) { return handleTrackPingCheck_(d); },
  leaderSummary: function(d) { return handleLeaderSummary_(d); },
  leaderAll: function(d) { return handleLeaderAll_(d); },
  weather: function(d) { return handleWeather_(d); },
  setCampLocation: function(d) { return handleSetCampLocation_(d); },
  printList: function(d) { return handlePrintList_(d); },
  createCase: function(d) { return handleCreateCase_(d); },
  listCases: function(d) { return handleListCases_(d); },
  updateCase: function(d) { return handleUpdateCase_(d); },
  myCases: function(d) { return handleMyCases_(d); },
  history: function(d) { return handleHistory_(d); },
  custodyFind: function(d) { return handleCustodyFind_(d); },
  custodyRecord: function(d) { return handleCustodyRecord_(d); },
  custodySummary: function(d) { return handleCustodySummary_(d); },
  withdrawStart: function(d) { return handleWithdrawStart_(d); },
  medClearCreate: function(d) { return handleMedClearCreate_(d); },
  medClearList: function(d) { return handleMedClearList_(d); },
  medClearApprove: function(d) { return handleMedClearApprove_(d); },
  medClearReturn: function(d) { return handleMedClearReturn_(d); },
  withdrawClose: function(d) { return handleWithdrawClose_(d); },
  withdrawCancel: function(d) { return handleWithdrawCancel_(d); },
  withdrawReopen: function(d) { return handleWithdrawReopen_(d); },
  gateList: function(d) { return handleGateList_(d); },
  gateCheck: function(d) { return handleGateCheck_(d); },
  gateConfirm: function(d) { return handleGateConfirm_(d); },
  withdrawList: function(d) { return handleWithdrawList_(d); },
  medFind: function(d) { return handleMedFind_(d); },
  medInfo: function(d) { return handleMedInfo_(d); },
  medOpen: function(d) { return handleMedOpen_(d); },
  medUpdate: function(d) { return handleMedUpdate_(d); },
  medClose: function(d) { return handleMedClose_(d); },
  medList: function(d) { return handleMedList_(d); },
  medStats: function(d) { return handleMedStats_(d); },
  nutritionSummary: function(d) { return handleNutritionSummary_(d); },
  nutritionAck: function(d) { return handleNutritionAck_(d); },
  prayerList: function(d) { return handlePrayerList_(d); },
  prayerSave: function(d) { return handlePrayerSave_(d); },
  displayTheme: function(d) { return handleDisplayTheme_(d); },
  programList: function(d) { return handleProgramList_(d); },
  programImport: function(d) { return handleProgramImport_(d); },
  programReview: function(d) { return handleProgramReview_(d); },
  teamsSave: function(d) { return handleTeamsSave_(d); },
  roundSave: function(d) { return handleRoundSave_(d); },
  receptionFind: function(d) { return handleReceptionFind_(d); },
  receptionArrive: function(d) { return handleReceptionArrive_(d); },
  receptionUndo: function(d) { return handleReceptionUndo_(d); },
  receptionList: function(d) { return handleReceptionList_(d); },
  studentAdd: function(d) { return handleStudentAdd_(d); },
  studentAddList: function(d) { return handleStudentAddList_(d); },
  reportOptions: function(d) { return handleReportOptions_(d); },
  reportData: function(d) { return handleReportData_(d); },
  shirtStock: function(d) { return handleShirtStock_(d); },
  shirtFind: function(d) { return handleShirtFind_(d); },
  shirtGive: function(d) { return handleShirtGive_(d); },
  shirtUndo: function(d) { return handleShirtUndo_(d); },
  shirtStockSet: function(d) { return handleShirtStockSet_(d); },
  shirtAddStaff: function(d) { return handleShirtAddStaff_(d); },
  nutritionSetStaff: function(d) { return handleNutritionSetStaff_(d); },
  mediaList: function(d) { return handleMediaList_(d); },
  annSave: function(d) { return handleAnnSave_(d); },
  annStatus: function(d) { return handleAnnStatus_(d); },
  resSave: function(d) { return handleResSave_(d); },
  resStatus: function(d) { return handleResStatus_(d); },
  resSaveBatch: function(d) { return handleResSaveBatch_(d); },
  lostAdd: function(d) { return handleLostAdd_(d); },
  lostList: function(d) { return handleLostList_(d); },
  lostReturn: function(d) { return handleLostReturn_(d); },
  lostFlash: function(d) { return handleLostFlash_(d); },
  lostImage: function(d) { return handleLostImage_(d); },
  bulletin: function(d) { return handleBulletin_(d); },
  stages: function(d) { return handleStages_(d); },
  feed: function(d) { return handleFeed_(d); }
};

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents || e.postData.contents.length > 200000) {
      return json_({ success: false, error: 'Bad request' });
    }
    const data = JSON.parse(e.postData.contents);
    const fn = Object.prototype.hasOwnProperty.call(ACTIONS_, data.action) ? ACTIONS_[data.action] : null;
    if (!fn) return json_({ success: false, error: 'Invalid action' });
    const out = fn(data);
    if (['leaderSummary', 'leaderAll', 'weather', 'trackPingCheck', 'lostImage', 'lostList', 'feed'].indexOf(data.action) === -1) { try { CacheService.getScriptCache().removeAll(['leader_v1', 'leader_x1']); } catch (e) { /* ignore */ } }
    return json_(out);
  } catch (error) {
    Logger.log('doPost error: ' + error + '\n' + (error && error.stack));
    return json_({ success: false, error: 'Server error' }); // never leak internals
  }
}

// Unique record id: time + random suffix (two records created in the same millisecond never collide).
function newId_(prefix) {
  return prefix + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 46656).toString(36).toUpperCase().padStart(3, '0');
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
  shirt: ['shirt size', 'shirt', 'size', 'مقاس القميص', 'المقاس'],
  bags: ['bags', 'bag count', 'عدد الحقائب'],
  foodAllergy: ['food allergy', 'food allergies', 'allergy', 'الحساسية الغذائية', 'حساسية الطعام'],
  medical: ['medical notes', 'medical', 'health', 'chronic', 'ملاحظات طبية', 'الحالة الصحية'],
  age: ['age', 'العمر', 'age (years)'],
  dob: ['date of birth', 'dob', 'birth date', 'birthdate', 'birthday', 'تاريخ الميلاد', 'تاريخ الولادة'],
  trip: ['trip', 'external trip', 'رحلة', 'الرحلة', 'رحلة خارجية', 'الرحلة الخارجية']
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
  if (cols.dob === -1) { for (let i = 0; i < norm.length; i++) { if (/birth|ميلاد|ولادة/.test(norm[i])) { cols.dob = i; break; } } } // any header that mentions a birth date
  return cols;
}

// Parents often write "لا يوجد" / "no" / "-" in health fields: treat these as empty.
function realValue_(v) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  const k = t.replace(/[.\-–—_\s\/]/g, '').toLowerCase();
  return /^(|لا|لايوجد|لاتوجد|لاشيء|لاشي|ليس|ليسلديه|ليسلديهحساسية|لايعاني|سليم|none|no|non|na|nil|nothing|0)$/.test(k) ? '' : t;
}

// Birth date: a real date, or text like 2012-05-17 / 17/05/2012 / ١٧-٥-٢٠١٢ -> {y,m,d} or null. Unreadable = null.
function parseDob_(v) {
  let y, m, d;
  if (v instanceof Date) { if (isNaN(v.getTime())) return null; y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate(); }
  else {
    const s = latinDigits_(String(v === undefined || v === null ? '' : v)).trim(); let x;
    if ((x = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else if ((x = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})/.exec(s))) { y = +x[3]; d = +x[1]; m = +x[2]; if (m > 12 && d <= 12) { const k = d; d = m; m = k; } } // day first (month first only when the first part cannot be a month)
    else return null;
  }
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y > 1900 ? { y: y, m: m, d: d } : null;
}
// Age in whole years (Muscat today). Unlikely ages (< 3 or > 30) = ''.
function ageFromDob_(v, nowMs) {
  const b = parseDob_(v); if (!b) return '';
  const n = new Date((nowMs || Date.now()) + 4 * 3600000), ny = n.getUTCFullYear(), nm = n.getUTCMonth() + 1, nd = n.getUTCDate();
  let age = ny - b.y; if (nm < b.m || (nm === b.m && nd < b.d)) age--;
  return age >= 3 && age <= 30 ? String(age) : '';
}
function dobText_(v) { const b = parseDob_(v); return b ? b.y + '-' + (b.m < 10 ? '0' : '') + b.m + '-' + (b.d < 10 ? '0' : '') + b.d : ''; }
// fresh=true skips the cache (used inside the lock when a new student number is chosen).
function readStudents_(fresh) {
  const cache = CacheService.getScriptCache();
  if (!fresh) { const hit = cache.get('students_v2'); if (hit) { try { return JSON.parse(hit); } catch (e) { /* fall through */ } } }
  const startedAt = Date.now();
  const sheet = SpreadsheetApp.openById(getStudentSpreadsheetId_()).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('تبويب Bus غير موجود في كشف الطلاب');
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
      shirt: String(cell(data[i], 'shirt') || '').trim(),
      bags: Number(cell(data[i], 'bags')) || 0,
      foodAllergy: realValue_(cell(data[i], 'foodAllergy')),
      medical: realValue_(cell(data[i], 'medical')),
      dob: cols.dob !== -1 ? dobText_(cell(data[i], 'dob')) : '', // only the doctor's screen (medInfo) ever sends this
      age: cols.dob !== -1 && cell(data[i], 'dob') !== '' ? ageFromDob_(cell(data[i], 'dob')) : String(cell(data[i], 'age') === undefined || cell(data[i], 'age') === null ? '' : cell(data[i], 'age')).trim().slice(0, 4), // the birth date itself is never sent anywhere, only the age
      trip: isYes_(cell(data[i], 'trip')),
      _row: i + 1
    });
  }
  readExtraStudents_().forEach(function(x) { if (!students.some(function(s) { return s.id === x.id; })) students.push(x); }); // students added by hand
  const result = { students: students, cols: cols };
  try {
    // A student added while we were reading must not be hidden by our older copy (see clearStudentsCache_):
    // cache it, THEN check, so whichever order the two run in, a stale copy is always removed.
    cache.put('students_v2', JSON.stringify(result), 180); // the student list rarely changes; every app-made change clears it (see clearStudentsCache_), a manual edit in the sheet shows within 3 minutes
    if ((Number(cache.get('students_cleared_at')) || 0) >= startedAt) cache.remove('students_v2');
  } catch (e) { /* too large: skip cache */ }
  return result;
}
function clearStudentsCache_() {
  try { const cache = CacheService.getScriptCache(); cache.put('students_cleared_at', String(Date.now()), 600); cache.remove('students_v2'); } catch (e) { /* ignore */ }
}

function findStudent_(id) {
  const key = String(id === undefined || id === null ? '' : id).trim();
  if (!key || key.length > 40) return null;
  return readStudents_().students.find(function(s) { return s.id === key; }) || null;
}

function busSupervisorName_(bus) {
  const rows = readUsersCached_();
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
// Movements ('board' = in the camp, 'exit' = left: on the trip or went home) are ordered by their STAGE, not by the
// moment they reached the server: a trip-exit queued offline and sent after the trip came back must not put the student
// back "on the trip". Rows without a stage (before stages existed, guardian arrivals) take the stage running at that time.
// Withdrawal (guardian took him, approved by the secretariat) is a layer on top: 'readmit' removes it.
function scanStates_() {
  const data = scansSheet_().getDataRange().getValues();
  const h = data[0] || [];
  const ix = function(n) { return h.indexOf(n); };
  const iT = ix('Time'), iS = ix('StudentID'), iA = ix('Action'), iB = ix('Bus'), iU = ix('Supervisor'), iC = ix('ClientId'), iM = ix('Method'), iN = ix('Notes'), iG = ix('StageId');
  const stages = readStages_() || [], byId = {};
  stages.forEach(function(x) { byId[x.id] = x; });
  const started = stages.filter(function(x) { return x.startMs; });
  const orderAt = function(t) { let o = 0; started.forEach(function(x) { if (x.startMs <= t && x.order > o) o = x.order; }); return o; };
  const hist = {}, wd = {}, clients = {};
  for (let r = 1; r < data.length; r++) {
    const id = String(data[r][iS]).trim();
    if (!id) continue;
    const act = String(data[r][iA]);
    const when = data[r][iT] instanceof Date ? data[r][iT] : new Date(data[r][iT]);
    if (iC !== -1 && data[r][iC]) clients[String(data[r][iC])] = { id: id, act: act };
    if (act === 'board' || act === 'exit') {
      const sid = iG !== -1 ? String(data[r][iG] || '').trim() : '', stg = byId[sid] || null;
      const viaG = act === 'board' && iM !== -1 && String(data[r][iM]) === 'guardian';
      addMove_(hist, id, { state: act === 'board' ? 'boarded' : (stg && stg.tripOnly ? 'on_trip' : 'departed'), at: when, by: data[r][iU], bus: String(data[r][iB]),
        via: viaG ? 'guardian' : '', note: viaG && iN !== -1 ? String(data[r][iN]) : '', stage: stg ? stg.id : '', anyBus: !!(stg && stg.anyBus),
        ord: stg ? stg.order : orderAt(when.getTime()), seq: r });
    }
    else if (act === 'withdraw') wd[id] = { state: 'withdrawn', at: when, by: data[r][iU], bus: String(data[r][iB]) };
    else if (act === 'readmit') delete wd[id]; // back to what he was before the withdrawal
    else if (act === 'undo') { if (hist[id]) hist[id].pop(); }
  }
  const states = {};
  Object.keys(hist).forEach(function(id) { stateOf_(states, hist, wd, id); });
  Object.keys(wd).forEach(function(id) { stateOf_(states, hist, wd, id); });
  return { states: states, clients: clients, hist: hist, wd: wd };
}
// Keep each student's movements sorted by (stage order, arrival order); the last one is where he is now.
function addMove_(hist, id, rec) {
  const list = hist[id] || (hist[id] = []);
  let k = list.length;
  while (k > 0 && list[k - 1].ord > rec.ord) k--;
  list.splice(k, 0, rec);
}
function stateOf_(states, hist, wd, id) {
  const list = hist[id] || [], top = list.length ? list[list.length - 1] : null;
  if (wd[id]) states[id] = Object.assign({}, wd[id], { prev: top });
  else if (top) states[id] = top;
  else delete states[id];
  return states[id];
}
const MOVE_STATES_ = ['boarded', 'on_trip', 'departed'];

function fmtTime_(d) { return Utilities.formatDate(d, 'Asia/Muscat', 'HH:mm'); }

function busCounts_(bus, students, states) {
  const mine = students.filter(function(s) { return s.bus === String(bus); });
  const missing = [], boarded = [];
  mine.forEach(function(s) {
    const st = states[s.id];
    if (st && st.state === 'boarded') boarded.push(s); else if (!st) missing.push(s); // left (trip / home / withdrawn) is not "missing"
  });
  return { total: mine.length, boarded: boarded.length, missing: missing };
}

function publicStudent_(s, st, withSup) {
  const out = { id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus,
    state: st ? st.state : 'none', at: st && st.at ? fmtTime_(st.at) : '', via: st && st.via ? st.via : '' };
  if (withSup) out.supervisor = busSupervisorName_(s.bus);
  return out;
}

// All students of the caller's bus (or every bus with the allbuses permission).
function handleRoster_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) { return buildRoster_(user, data); });
}
// The roster of the caller's bus. Also used by the login (so a supervisor's screen needs no second request right after he signs in).
function buildRoster_(user, data) {
  {
    const students = readStudents_().students;
    const all = hasPerm_(user, 'allbuses');
    const bus = all && data.bus ? String(data.bus) : String(user.AssignedBus).trim();
    if (!bus) return { success: false, error: 'حسابك غير مرتبط بباص. يُرجى التواصل مع السكرتارية لتعيين باص لك' };
    const sc = scanStates_(), states = sc.states;
    const stages = readStages_(), nowMs = Date.now(), open = stages ? openStages_(stages, nowMs) : [];
    const list = students.filter(function(s) { return s.bus === bus; }).map(function(s) {
      const o = publicStudent_(s, states[s.id], false); o.photo = s.photo; o.bagsExpected = s.bags;
      if (stages) { o.inStage = open.some(function(x) { return stageIncludes_(x, s); }); o.stageDone = open.some(function(x) { return !!stageRec_(sc, s.id, x); }); o.stagesOk = stagesOf_(stages, s); o.stagesDone = stages.filter(function(x) { return !!stageRec_(sc, s.id, x); }).map(function(x) { return x.id; }); }
      return o;
    });
    const c = busCounts_(bus, students, states);
    const out = { success: true, bus: bus, students: list, total: c.total, boarded: c.boarded, lastRound: null }; // (the round check is switched off: its tab is no longer read here, one Sheets call less)
    // What the supervisor is doing NOW, from the clock: the stages open at this moment (movement, who is accepted, his share) and the next one.
    if (stages) {
      out.stages = true;
      out.allStages = stages.map(stageBrief_); // the stages the supervisor can choose from (the clock only suggests one)
      out.mineByStage = {}; stages.forEach(function(x) { out.mineByStage[x.id] = stageMine_(x, user, students, sc); });
      out.openStages = open.map(function(x) { return Object.assign(stageBrief_(x), { mine: stageMine_(x, user, students, sc) }); });
      out.stage = out.openStages[0] || null; if (out.stage) out.mine = out.stage.mine;
      const n = nextStageAfter_(stages, nowMs); out.next = n ? stageBrief_(n) : null;
    }
    return out;
  }
}

// View-only search across ALL buses (never records anything).
function handleLookup_(data) {
  return withAuth_(data, requirePerm_('checkin'), function() {
    const q = String(data.q === undefined ? '' : data.q).trim().toLowerCase();
    if (q.length < 1 || q.length > 60) return { success: true, results: [] };
    const students = readStudents_().students;
    const states = scanStates_().states, stages = readStages_();
    const res = students.filter(function(s) { return s.id.toLowerCase() === q || s.id.indexOf(q) === 0 || (q.length >= 2 && s.name.toLowerCase().indexOf(q) !== -1); })
      .slice(0, 8).map(function(s) { const o = publicStudent_(s, states[s.id], true); if (stages) o.stagesOk = stagesOf_(stages, s); return o; });
    return { success: true, results: res };
  });
}

function handleScan_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const action = String(data.op); // sub-operation (data.action is the API route)
    if (['board', 'undo', 'withdraw'].indexOf(action) === -1) return { success: false, code: 'BAD_REQUEST', error: 'Invalid scan action' };
    // "Left with permission" is approved by the secretariat (custody screen), never by a bus supervisor's scan.
    if (action === 'withdraw' && !hasPerm_(user, 'custody')) return { success: false, code: 'FORBIDDEN', error: 'الخروج بإذن تعتمده السكرتارية من شاشة الاستئذان' };
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    // Stages: once the Stages tab exists, a scan records the movement of the stage that is open NOW for this student (by date + time).
    const stages = readStages_(), atMs = scanTime_(data), want = String(data.stageId || '').trim();
    let stage = null, late = false;
    if (stages && action === 'board') {
      if (want) { // the supervisor CHOSE the stage (the organisers tell him which): no clock check; only "does this student belong to it?"
        const x = stages.filter(function(y) { return y.id === want; })[0];
        if (!x) return { success: false, code: 'NO_STAGE', error: 'مرحلة غير معروفة', student: publicStudent_(student, scanStates_().states[student.id], false) };
        if (!stageIncludes_(x, student)) return { success: false, code: 'NOT_IN_STAGE', error: 'ليس ضمن مرحلة «' + x.name + '»', student: publicStudent_(student, scanStates_().states[student.id], false), stage: stageBrief_(x) };
        stage = x;
      } else { // no stage sent (an old phone page): the stage open now by the clock, as before
        const pick = stageForStudent_(stages, student, atMs);
        if (!pick.ok) return { success: false, code: pick.code, error: pick.error, student: publicStudent_(student, scanStates_().states[student.id], false), stage: pick.stage ? stageBrief_(pick.stage) : null };
        stage = pick.stage; late = atMs > stage.endMs;
      }
    }
    // Scope comes from the SHEET's bus for this student, never from the client. Trip stages: any trip bus (the bus he really took is recorded).
    const anyBus = !!(stage && stage.anyBus);
    if (action !== 'undo' && !anyBus && !canRecordFor_(user, student)) {
      return { success: false, code: 'OTHER_BUS', error: 'هذا الطالب ليس في باصك', student: publicStudent_(student, scanStates_().states[student.id], true) };
    }
    const recBus = anyBus ? (hasPerm_(user, 'allbuses') && data.bus ? String(data.bus).slice(0, 10) : (String(user.AssignedBus || '').trim() || student.bus)) : student.bus;
    const clientId = String(data.clientId || '').slice(0, 60);
    const sheet = scansSheet_(); // C2: open the spreadsheet BEFORE taking the lock (opening costs ~0.4 s; the lock is shared by every write)
    const iStage = stage ? scanHeaders_(sheet).indexOf('StageId') : -1;
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sc = scanStates_();
      if (clientId && sc.clients[clientId]) { // retry of an already-applied request: idempotent
        const c0 = busCounts_(student.bus, readStudents_().students, sc.states);
        return { success: true, repeated: true, student: publicStudent_(student, sc.states[student.id], false), boarded: c0.boarded, total: c0.total, stage: stage ? stageBrief_(stage) : null };
      }
      const cur = sc.states[student.id];
      if (action === 'undo' && !canRecordFor_(user, student) && !(cur && cur.anyBus && cur.by === user.Username)) {
        return { success: false, code: 'OTHER_BUS', error: 'هذا الطالب ليس في باصك', student: publicStudent_(student, cur, true) };
      }
      let warn = '';
      if (action === 'board') {
        if (cur && cur.state === 'withdrawn') return { success: false, code: 'WITHDRAWN', error: 'الطالب خرج بإذن', student: publicStudent_(student, cur, false) };
        if (!stage || stage.dir === 'in') {
          // Same stage twice = duplicate. Already "in" from an EARLIER stage (e.g. his trip-exit, scanned offline, has not reached us yet):
          // recorded anyway, so the late exit, filed under its older stage, can never put him back "on the trip".
          if (cur && cur.state === 'boarded' && (!stage || cur.stage === stage.id || cur.ord >= stage.order)) return { success: false, code: 'DUPLICATE', error: 'مسجَّل صعوده مسبقاً', at: fmtTime_(cur.at), student: publicStudent_(student, cur, false) };
          if (cur && cur.state === 'boarded') warn = 'ALREADY_IN';
        } else {
          if (cur && cur.stage === stage.id) return { success: false, code: 'DUPLICATE', error: 'مسجَّل خروجه مسبقاً', at: fmtTime_(cur.at), student: publicStudent_(student, cur, false) };
          if (cur && cur.state !== 'boarded' && cur.ord >= stage.order) return { success: false, code: 'DUPLICATE', error: 'مسجَّل خروجه مسبقاً', at: fmtTime_(cur.at), student: publicStudent_(student, cur, false) };
          if (!cur || cur.state !== 'boarded') warn = 'NO_ARRIVAL'; // recorded anyway: he is leaving now; the secretariat sees it
        }
      }
      if (action === 'undo') {
        if (!cur || MOVE_STATES_.indexOf(cur.state) === -1) return { success: false, code: 'NOTHING_TO_UNDO', error: 'لا يوجد تسجيل للتراجع عنه' };
        if (!hasPerm_(user, 'undo')) { // only holders of the 'undo' permission may undo any student at any time
          if (Date.now() - cur.at.getTime() > UNDO_WINDOW_MS) return { success: false, code: 'UNDO_EXPIRED', error: 'انتهت مهلة التراجع. اطلب من المشرف العام' };
          let lastMine = 0;
          Object.keys(sc.states).forEach(function(k) { const x = sc.states[k]; if (MOVE_STATES_.indexOf(x.state) !== -1 && x.by === user.Username && x.at.getTime() > lastMine) lastMine = x.at.getTime(); });
          if (cur.by !== user.Username || cur.at.getTime() !== lastMine) return { success: false, code: 'NOT_LAST', error: 'يمكنك التراجع عن آخر تسجيل لك فقط. اطلب من المشرف العام' };
        }
      }
      if (action === 'withdraw' && cur && cur.state === 'withdrawn') return { success: false, code: 'ALREADY_WITHDRAWN', error: 'خرج مسبقاً' };
      const now = new Date(), method = String(data.method || '').slice(0, 20);
      let notes = String(data.notes || '').slice(0, 200);
      if (late) notes = (notes ? notes + ' · ' : '') + 'وصل بعد انتهاء نافذة المرحلة (مسح بلا إنترنت)';
      const act = action === 'board' && stage && stage.dir === 'out' ? 'exit' : action;
      const stageId = stage ? stage.id : (action === 'undo' && cur && cur.stage ? cur.stage : '');
      const row = [now, student.id, act, recBus, user.Username, method, clientId, notes];
      const iG = stage ? iStage : (stageId ? scanHeaders_(sheet).indexOf('StageId') : -1);
      if (stageId && iG !== -1) { while (row.length < iG) row.push(''); row[iG] = stageId; }
      appendSafe_(sheet, row);
      if (action === 'undo') writeAudit_(user.Username, 'SCAN_UNDO', student.id, 'bus=' + student.bus + (stageId ? ' stage=' + stageId : ''));
      // C3: the new state comes from the row we just wrote, by the SAME rules as scanStates_ (no second full read of the log inside the lock).
      if (action === 'board') {
        const viaG = method === 'guardian';
        addMove_(sc.hist, student.id, { state: act === 'board' ? 'boarded' : (stage.tripOnly ? 'on_trip' : 'departed'), at: now, by: user.Username, bus: String(recBus),
          via: viaG ? 'guardian' : '', note: viaG ? notes : '', stage: stage ? stage.id : '', anyBus: anyBus, ord: stage ? stage.order : orderNow_(stages), seq: Infinity });
      } else if (action === 'withdraw') sc.wd[student.id] = { state: 'withdrawn', at: now, by: user.Username, bus: String(student.bus) };
      else if (action === 'undo' && sc.hist[student.id]) sc.hist[student.id].pop();
      const st = stateOf_(sc.states, sc.hist, sc.wd, student.id);
      const students = readStudents_().students, c = busCounts_(student.bus, students, sc.states);
      const out = { success: true, student: publicStudent_(student, st, false), boarded: c.boarded, total: c.total };
      if (stage) { out.stage = stageBrief_(stage); out.mine = stageMine_(stage, user, students, sc); }
      if (warn) out.warn = warn;
      return out;
    } finally {
      lock.releaseLock();
    }
  });
}

// ---------------- Stages (مراحل المخيم): each stage has a DATE and a time window; the scan follows the clock ----------------
// For every scan the server asks: which stage is open NOW for THIS student? Found -> its movement (in / out) is recorded;
// not found -> the scan is refused and the supervisor is told why. Nobody starts or ends a stage by hand.
// Times are Muscat time (UTC+4, no daylight saving). A window may be edited in the Stages tab (applies within a minute).
// The Stages tab is created (with the camp's six stages) by SETUP_createStages. No tab = the old behaviour (no stages).
const STAGES_HEADERS_ = ['StageId', 'Order', 'Name', 'Direction', 'Grades', 'TripOnly', 'AnyBus', 'Day', 'Date', 'From', 'To'];
// Text cells start with ' so Sheets keeps them as typed ("7-11" would otherwise become a date, "14:00" a time).
const STAGES_SEED_ = [
  ['S1', 1, 'وصول 7-11', 'in', "'7-11", false, false, 'الأربعاء 30/12', "'2026-12-30", "'14:00", "'20:00"],
  ['S2', 2, 'وصول 4-6', 'in', "'4-6", false, false, 'الجمعة 1/1', "'2027-01-01", "'07:00", "'11:00"],
  ['S3', 3, 'خروج الرحلة', 'out', '', true, true, 'الجمعة 1/1', "'2027-01-01", "'08:00", "'13:00"],
  ['S4', 4, 'مغادرة 4-6', 'out', "'4-6", false, false, 'السبت 2/1', "'2027-01-02", "'09:30", "'12:00"],
  ['S5', 5, 'عودة الرحلة', 'in', '', true, true, 'السبت 2/1', "'2027-01-02", "'11:00", "'16:00"],
  ['S6', 6, 'مغادرة 7-11', 'out', "'7-11", false, false, 'السبت 2/1', "'2027-01-02", "'17:30", "'21:00"]
];
const STAGE_GRACE_MS_ = 15 * 60 * 1000; // a scan made offline may reach us after the window closed: accepted for 15 more minutes
const MUSCAT_MS_ = 4 * 3600 * 1000;

function isYes_(v) { return v === true || /^(نعم|ن|yes|y|true|1|✓|✔|x)$/i.test(String(v === undefined || v === null ? '' : v).trim()); }
function latinDigits_(t) { return String(t).replace(/[٠-٩]/g, function(d) { return String(d.charCodeAt(0) - 0x0660); }).replace(/[۰-۹]/g, function(d) { return String(d.charCodeAt(0) - 0x06F0); }); }
const GRADE_WORDS_ = [['الحادي عشر', 11], ['الثاني عشر', 12], ['الرابع', 4], ['الخامس', 5], ['السادس', 6], ['السابع', 7], ['الثامن', 8], ['التاسع', 9], ['العاشر', 10]];
function gradeOf_(cls) {
  const t = latinDigits_(cls === undefined || cls === null ? '' : cls), m = /\d+/.exec(t);
  if (m) return Number(m[0]);
  for (let i = 0; i < GRADE_WORDS_.length; i++) if (t.indexOf(GRADE_WORDS_[i][0]) !== -1) return GRADE_WORDS_[i][1];
  return null;
}
// "7-11" -> [7..11]; "4,5,6" -> [4,5,6]; empty -> null (every grade). A cell Sheets turned into a date (7-11 -> 11 July) is read back.
function parseGrades_(v) {
  if (v instanceof Date) v = (v.getMonth() + 1) + '-' + v.getDate();
  const t = latinDigits_(v === undefined || v === null ? '' : v).trim().replace(/^'/, ''); // a text-marking apostrophe, if one shows up
  if (!t) return null;
  const r = /^(\d+)\s*[-–]\s*(\d+)$/.exec(t);
  if (r) { const out = []; for (let g = Number(r[1]); g <= Number(r[2]); g++) out.push(g); return out; }
  const list = (t.match(/\d+/g) || []).map(Number);
  return list.length ? list : null;
}
function gradesText_(g) { return !g ? '' : g.length > 2 && g[g.length - 1] - g[0] === g.length - 1 ? g[0] + '-' + g[g.length - 1] : g.join('، '); }
// Date cell: text "2026-12-30" (or 2026/12/30), or a real date if Sheets converted it. Time cell: text "14:00", or a real time.
function parseStageDate_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : { y: v.getFullYear(), m: v.getMonth() + 1, d: v.getDate() };
  const m = /^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/.exec(latinDigits_(v === undefined || v === null ? '' : v).trim().replace(/^'/, ''));
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}
function parseStageTime_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getHours() * 60 + v.getMinutes();
  if (typeof v === 'number' && v >= 0 && v < 1) return Math.round(v * 1440);
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(latinDigits_(v === undefined || v === null ? '' : v).trim().replace(/^'/, ''));
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function hhmm_(min) { return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2); }

function stagesSheetOrNull_() { try { return getSheetByName_('Stages'); } catch (e) { return null; } }
// The windows are cached 60 s (a time edited in the sheet applies within a minute). The cache holds only the windows:
// whether a stage is "now" is always computed from the clock, never cached.
function readStages_() {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('stages_v2'); if (hit) { const o = JSON.parse(hit); return o.list || null; } } catch (e) { /* fall through */ }
  const sh = stagesSheetOrNull_();
  let list = null;
  if (sh) {
    const v = sh.getDataRange().getValues(), h = v[0] || [];
    const g = function(r, n) { const i = h.indexOf(n); return i === -1 ? '' : v[r][i]; };
    list = [];
    for (let r = 1; r < v.length; r++) {
      const id = String(g(r, 'StageId')).trim();
      if (!id) continue;
      const dt = parseStageDate_(g(r, 'Date')), f = parseStageTime_(g(r, 'From')), t = parseStageTime_(g(r, 'To'));
      let startMs = 0, endMs = 0;
      if (dt && f !== null && t !== null) {
        startMs = Date.UTC(dt.y, dt.m - 1, dt.d, 0, f) - MUSCAT_MS_; endMs = Date.UTC(dt.y, dt.m - 1, dt.d, 0, t) - MUSCAT_MS_;
        if (endMs <= startMs) endMs += 86400000; // "22:00 – 02:00" runs past midnight
      }
      list.push({ id: id, order: Number(g(r, 'Order')) || r, name: String(g(r, 'Name')).trim() || id, dir: String(g(r, 'Direction')).trim().toLowerCase() === 'out' ? 'out' : 'in',
        grades: parseGrades_(g(r, 'Grades')), tripOnly: isYes_(g(r, 'TripOnly')), anyBus: isYes_(g(r, 'AnyBus')),
        day: String(g(r, 'Day')).trim(), from: f === null ? '' : hhmm_(f), to: t === null ? '' : hhmm_(t), startMs: startMs, endMs: endMs });
    }
    list.sort(function(a, b) { return a.order - b.order; });
    if (!list.length) list = null; // an empty tab = no stages
  }
  try { cache.put('stages_v2', JSON.stringify({ list: list }), 60); } catch (e) { /* ignore */ }
  return list;
}
function clearStagesCache_() { try { CacheService.getScriptCache().remove('stages_v2'); } catch (e) { /* ignore */ } }
function stageStatusAt_(x, ms) { return !x.startMs ? 'none' : ms < x.startMs ? 'next' : ms <= x.endMs ? 'live' : 'done'; }
// Stages open for scanning at that moment (the window plus the 15-minute grace for scans made offline).
function openStages_(stages, ms) { return (stages || []).filter(function(x) { return x.startMs && ms >= x.startMs && ms <= x.endMs + STAGE_GRACE_MS_; }); }
// The ids of the stages that include this student (the phone combines them with the clock).
function stagesOf_(stages, s) { return (stages || []).filter(function(x) { return stageIncludes_(x, s); }).map(function(x) { return x.id; }); }
function nextStageAfter_(stages, ms) { return (stages || []).filter(function(x) { return x.startMs > ms; }).sort(function(a, b) { return a.startMs - b.startMs; })[0] || null; }
function orderNow_(stages) { let o = 0; const t = Date.now(); (stages || []).forEach(function(x) { if (x.startMs && x.startMs <= t && x.order > o) o = x.order; }); return o; }
// When the scan was made: the phone's clock if it sent one and it is believable (not in the future, not older than 6 h), else now.
function scanTime_(data) { const now = Date.now(), c = Number(data.clientTime) || 0; return c && c <= now + 120000 && c >= now - 6 * 3600000 ? c : now; }
function stageIncludes_(stage, s) {
  if (stage.tripOnly && !s.trip) return false;
  if (stage.grades && stage.grades.indexOf(gradeOf_(s.cls)) === -1) return false;
  return true;
}
function stageWho_(stage) {
  if (stage.tripOnly) return 'المسجّلون في الرحلة فقط' + (stage.grades ? ' (' + gradesText_(stage.grades) + ')' : '');
  return stage.grades ? 'الصفوف ' + gradesText_(stage.grades) : 'كل الطلاب';
}
function stageBrief_(x) {
  return { id: x.id, order: x.order, name: x.name, dir: x.dir, who: stageWho_(x), tripOnly: x.tripOnly, anyBus: x.anyBus, day: x.day, from: x.from, to: x.to,
    time: x.from && x.to ? x.from + ' – ' + x.to : '', status: stageStatusAt_(x, Date.now()), startMs: x.startMs, endMs: x.endMs };
}
// Which stage a scan belongs to: the one open at that moment that includes this student.
function stageForStudent_(stages, student, ms) {
  const open = openStages_(stages, ms), mine = open.filter(function(x) { return stageIncludes_(x, student); });
  if (mine.length) { mine.sort(function(a, b) { return b.startMs - a.startMs; }); return { ok: true, stage: mine[0] }; }
  if (open.length) return { ok: false, code: 'NOT_IN_STAGE', error: 'ليس ضمن مرحلة «' + open.map(function(x) { return x.name; }).join('» و«') + '» الجارية الآن', stage: open[0] };
  const nxt = (stages || []).filter(function(x) { return x.startMs > ms && stageIncludes_(x, student); }).sort(function(a, b) { return a.startMs - b.startMs; })[0] || null;
  return { ok: false, code: 'NO_STAGE', error: 'لا توجد مرحلة لهذا الطالب الآن' + (nxt ? '. القادمة: ' + nxt.name + ' · ' + nxt.day + ' ' + nxt.from : ''), stage: nxt };
}
// The student's record in this stage (still standing, i.e. not undone), even if a later stage moved him again.
function stageRec_(sc, id, stage) { const l = sc.hist[id] || []; for (let i = l.length - 1; i >= 0; i--) if (l[i].stage === stage.id) return l[i]; return null; }
// The supervisor's own share of the stage: his bus (or, on a trip stage, everyone he scanned + all trip students).
function stageMine_(stage, user, students, sc) {
  const bus = String(user.AssignedBus || '').trim();
  const everyBus = stage.anyBus || (!bus && hasPerm_(user, 'allbuses'));
  const mine = students.filter(function(s) { return stageIncludes_(stage, s) && (everyBus || s.bus === bus); });
  const done = mine.filter(function(s) { return stageRec_(sc, s.id, stage); });
  const byMe = stage.anyBus ? students.filter(function(s) { const x = stageRec_(sc, s.id, stage); return x && String(x.bus) === bus; }).length : done.length;
  return { total: mine.length, done: done.length, onMyBus: byMe };
}
// Per-stage numbers for the secretariat. Names only when asked (never phones).
function stageStats_(stage, students, sc, withNames) {
  const inc = students.filter(function(s) { return stageIncludes_(stage, s); });
  const perBus = {};
  let done = 0, withdrawn = 0;
  const remaining = [];
  inc.forEach(function(s) {
    const st = sc.states[s.id], moved = stageRec_(sc, s.id, stage);
    const b = moved && stage.anyBus ? String(moved.bus) : s.bus;
    const x = perBus[b] || (perBus[b] = { bus: b, total: 0, done: 0 });
    if (!stage.anyBus || !moved) x.total++;
    if (moved) { done++; x.done++; if (stage.anyBus) x.total++; }
    else if (st && st.state === 'withdrawn') withdrawn++;
    else if (withNames) remaining.push({ id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus });
  });
  const out = { expected: inc.length, done: done, withdrawn: withdrawn, perBus: Object.keys(perBus).sort().map(function(k) { return perBus[k]; }) };
  if (withNames) out.remaining = remaining;
  return out;
}
// The secretariat board (view only): every stage with its state by the clock, its numbers, and the names still missing in the running ones.
function handleStages_(data) {
  return withAuth_(data, requireAnyPerm_(['stages', 'manage', 'dashboard']), function() {
    const stages = readStages_();
    if (!stages) return { success: true, enabled: false, stages: [] };
    const students = readStudents_().students, sc = scanStates_();
    const list = stages.map(function(x) {
      const o = stageBrief_(x);
      Object.assign(o, stageStats_(x, students, sc, o.status === 'live'));
      return o;
    });
    return { success: true, enabled: true, stages: list, serverTime: new Date().toISOString() };
  });
}
// Scans tab header, so the StageId lands in its own column wherever it is.
function scanHeaders_(sheet) { return sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0].map(String); }

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

const CAMP_RADIUS_M = 400;
function campLocation_() {
  const lat = Number(getSetting_('CampLat')), lng = Number(getSetting_('CampLng'));
  return (isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0) && getSetting_('CampLat') !== null) ? { lat: lat, lng: lng } : null;
}
function handleSetCampLocation_(data) {
  return withAuth_(data, requirePerm_('manage'), function(user) {
    const lat = Number(data.lat), lng = Number(data.lng);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { success: false, error: 'موقع غير صالح' };
    setSetting_('CampLat', lat); setSetting_('CampLng', lng);
    writeAudit_(user.Username, 'CAMP_LOCATION_SET', '', lat + ',' + lng);
    return { success: true, camp: { lat: lat, lng: lng } };
  });
}

function distMeters_(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) * Math.sin((lat2 - lat1) * rad / 2) +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lng2 - lng1) * rad / 2) * Math.sin((lng2 - lng1) * rad / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

function handleBusStatus_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const bus = String(user.AssignedBus).trim();
    if (!bus) return { success: false, error: 'حسابك غير مرتبط بباص. يُرجى التواصل مع السكرتارية لتعيين باص لك' };
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
        Status: vals[row - 1][h.indexOf('Status')], Supervisor: vals[row - 1][h.indexOf('Supervisor')], UpdatedAt: vals[row - 1][h.indexOf('UpdatedAt')], Lat: vals[row - 1][h.indexOf('Lat')], Lng: vals[row - 1][h.indexOf('Lng')], Accuracy: vals[row - 1][h.indexOf('Accuracy')]
      };
      // No manual "departed" button anymore: the bus is 'onway' automatically once its position moves (> ~7 km/h between two updates).
      let autoStatus = '', speed = '';
      if (hasGeo && row !== -1 && prev.Lat !== '' && prev.Lng !== '') {
        const pu = vals[row - 1][h.indexOf('UpdatedAt')];
        const dt = (Date.now() - (pu instanceof Date ? pu.getTime() : new Date(pu).getTime())) / 1000;
        if (dt >= 5 && dt <= 600) {
          const v = distMeters_(Number(prev.Lat), Number(prev.Lng), lat, lng) / dt; // metres per second
          speed = Math.round(v * 10) / 10;
          if (v > 2) autoStatus = 'onway';
        }
      }
      // Arrived automatically when the bus is inside the camp area (camp location is set by the leader on the map).
      const camp = campLocation_();
      if (hasGeo && camp && distMeters_(camp.lat, camp.lng, lat, lng) <= CAMP_RADIUS_M) autoStatus = 'arrived';
      if (!autoStatus && prev.Status === 'arrived') autoStatus = 'arrived'; // stays arrived
      const rec = {
        Bus: bus, Status: status || autoStatus || prev.Status || 'boarding',
        Lat: hasGeo ? lat : (prev.Lat || ''), Lng: hasGeo ? lng : (prev.Lng || ''), Accuracy: hasGeo ? (Number(data.acc) || '') : (prev.Accuracy || ''),
        UpdatedAt: new Date(), Supervisor: user.FullName, Boarded: c.boarded, Total: c.total, Speed: speed
      };
      // A check-in WITHOUT a position (a computer, or a phone with location off) only refreshes the counts: it must not change the
      // supervisor's name or the "last seen" time, or it would hide a bus that is not really being tracked and overwrite a colleague's row.
      if (!hasGeo && row !== -1) { rec.Supervisor = prev.Supervisor; rec.UpdatedAt = prev.UpdatedAt; rec.Speed = ''; }
      const out = h.map(function(n) { return rec.hasOwnProperty(n) ? rec[n] : ''; });
      if (row === -1) appendSafe_(sheet, out); else sheet.getRange(row, 1, 1, out.length).setValues([out.map(cellSafe_)]);
      if (status === 'departed') writeAudit_(user.Username, 'BUS_DEPARTED', bus, 'boarded=' + c.boarded + '/' + c.total);
      if (hasGeo) { try { CacheService.getScriptCache().remove('trackping_' + bus); } catch (e) { /* ignore */ } } // tracking is on: the leader's request is answered
    } finally {
      lock.releaseLock();
    }
    return { success: true, boarded: c.boarded, total: c.total, missing: c.missing.length };
  });
}

// The leader asks a bus supervisor to switch tracking on. Kept 15 minutes in the cache (no sheet write);
// it disappears as soon as that bus sends a position.
function handleTrackPing_(data) {
  return withAuth_(data, requirePerm_('dashboard'), function(user) {
    const bus = String(data.bus || '').trim().slice(0, 10);
    if (!bus) return { success: false, error: 'Invalid request' };
    CacheService.getScriptCache().put('trackping_' + bus, JSON.stringify({ at: new Date().toISOString(), by: user.FullName || user.Username }), 900);
    writeAudit_(user.Username, 'TRACK_PING', bus, '');
    return { success: true };
  });
}
function handleTrackPingCheck_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const bus = String(user.AssignedBus).trim();
    let ping = null;
    if (bus) { try { const v = CacheService.getScriptCache().get('trackping_' + bus); if (v) ping = JSON.parse(v); } catch (e) { ping = null; } }
    return { success: true, ping: ping };
  });
}

function liveBuses_() {
  const vals = busLiveSheet_().getDataRange().getValues();
  const h = vals[0];
  const now = Date.now();
  const buses = [];
  for (let r = 1; r < vals.length; r++) {
    const g = function(n) { return vals[r][h.indexOf(n)]; };
    if (!g('Bus')) continue;
    const upd = g('UpdatedAt') instanceof Date ? g('UpdatedAt') : new Date(g('UpdatedAt'));
    buses.push({ bus: String(g('Bus')), status: g('Status'), lat: g('Lat') === '' ? null : Number(g('Lat')), lng: g('Lng') === '' ? null : Number(g('Lng')),
      ageSec: Math.max(0, Math.round((now - upd.getTime()) / 1000)), supervisor: g('Supervisor'), boarded: Number(g('Boarded')) || 0, total: Number(g('Total')) || 0,
      speed: h.indexOf('Speed') === -1 || g('Speed') === '' ? null : Number(g('Speed')) });
  }
  return buses;
}
function handleBusLive_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'livemap']), function() {
    return { success: true, buses: liveBuses_() };
  });
}

// Everything else the leader sees: names still missing per bus, supervisors' phones, headcount per team,
// committees in NUMBERS only (no medical details), the next event and the latest activity.
function leaderExtra_() {
  const students = readStudents_().students;
  const sc = scanStates_();
  const byId = {}; students.forEach(function(s) { byId[s.id] = s; });
  const buses = {}; students.forEach(function(s) { buses[s.bus] = true; });
  const missingByBus = {};
  Object.keys(buses).forEach(function(b) {
    missingByBus[b] = busCounts_(b, students, sc.states).missing.map(function(s) { return { id: s.id, name: s.name, team: s.team, cls: s.cls }; });
  });
  const users = readUsersCached_().filter(function(u) { return u.Active === true && String(u.AssignedBus || '').trim() !== ''; });
  const supervisors = {};
  users.forEach(function(u) { const b = String(u.AssignedBus).trim(); (supervisors[b] = supervisors[b] || []).push({ name: u.FullName, phone: String(u.Phone || '').trim() }); });
  const byTeam = {};
  students.forEach(function(s) {
    const t = s.team || '—', x = byTeam[t] || (byTeam[t] = { team: t, total: 0, present: 0 });
    x.total++; const st = sc.states[s.id]; if (st && st.state === 'boarded') x.present++;
  });
  const committees = {};
  try { const med = readMedCases_(); committees.medOpen = med.filter(function(m) { return m.status === 'open'; }).length; committees.medUrgent = med.filter(function(m) { return m.status === 'open' && m.severity === 'urgent'; }).length; committees.medToday = med.filter(function(m) { return String(m.openedAt).slice(0, 10) === new Date().toISOString().slice(0, 10); }).length; } catch (e) { /* tab missing */ }
  try { const cs = custodyStates_().states; let ph = 0, bg = 0; Object.keys(cs).forEach(function(k) { if (cs[k].phone) ph++; bg += cs[k].bags; }); committees.phones = ph; committees.bags = bg; } catch (e) { /* tab missing */ }
  try { committees.withdrawOpen = readWithdrawals_().filter(function(w) { return w.status === 'open'; }).length; } catch (e) { /* tab missing */ }
  // Numbers only for the leader's charts: clinic visits per day (Muscat date, no names, no details) and the progress of each stage.
  let medByDay = [];
  try { const m = {}; readMedCases_().forEach(function(c) { const d = new Date(c.openedAt); if (isNaN(d)) return; const k = new Date(d.getTime() + 4 * 3600000).toISOString().slice(0, 10); m[k] = (m[k] || 0) + 1; }); medByDay = Object.keys(m).sort().map(function(k) { return { day: k, count: m[k] }; }); } catch (e) { /* tab missing */ }
  let stageBars = [];
  try { const stg = readStages_(); if (stg) stageBars = stg.map(function(x) { const b = stageBrief_(x), s2 = stageStats_(x, students, sc, false); return { id: b.id, name: b.name, status: b.status, expected: s2.expected, done: s2.done }; }); } catch (e) { /* no stages */ }
  let present = 0; Object.keys(sc.states).forEach(function(k) { if (sc.states[k].state === 'boarded') present++; });
  committees.meals = present + users.length;
  let nextEvent = null;
  try {
    const now = new Date().toISOString();
    const ev = publicAnnouncements_(['public', 'staff']).filter(function(a) { return a.kind === 'event' && a.startsAt && a.startsAt > now; }).sort(function(a, b) { return a.startsAt < b.startsAt ? -1 : 1; })[0];
    if (ev) nextEvent = { title: ev.title, startsAt: ev.startsAt, body: ev.body };
  } catch (e) { /* tab missing */ }
  let withdrawals = [];
  try {
    withdrawals = readWithdrawals_().filter(function(w) { return w.status === 'open' || w.status === 'closed'; })
      .sort(function(a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 15).map(function(w) {
        const st = byId[w.studentId] || {};
        return { name: st.name || w.studentId, team: st.team || '', bus: st.bus || '', guardian: w.guardian, status: w.status, time: w.status === 'closed' && w.closedAt ? w.closedAt : w.time, by: w.status === 'closed' ? w.closedBy : w.by };
      });
  } catch (e) { /* tab missing */ }
  const feed = [];
  const sv = scansSheet_().getDataRange().getValues(), sh = sv[0];
  for (let r = sv.length - 1; r >= 1 && feed.length < 12; r--) {
    const id = String(sv[r][sh.indexOf('StudentID')]), t = sv[r][sh.indexOf('Time')];
    feed.push({ time: t instanceof Date ? t.toISOString() : String(t), action: String(sv[r][sh.indexOf('Action')]), bus: String(sv[r][sh.indexOf('Bus')]), name: byId[id] ? byId[id].name : id, by: String(sv[r][sh.indexOf('Supervisor')]), via: sh.indexOf('Method') !== -1 && String(sv[r][sh.indexOf('Method')]) === 'guardian' ? 'guardian' : '' });
  }
  let rounds = {}; try { rounds = latestRounds_(); } catch (e) { /* tab missing */ }
  return { rounds: rounds, medByDay: medByDay, stageBars: stageBars, missingByBus: missingByBus, supervisors: supervisors, byTeam: Object.keys(byTeam).sort().map(function(k) { return byTeam[k]; }), committees: committees, nextEvent: nextEvent, feed: feed, present: present, withdrawals: withdrawals };
}

// ---------------- Weather (the leader's card) ----------------
// Daily forecast from the free Open-Meteo service for the camp location (Barka unless the camp point was set). Cached 3 h; if the service is down
// the last good copy is served (marked old); the card never blocks the screen. The OFFICIAL Oman Met bulletin is a link on the card.
const WEATHER_TTL_ = 10800;
function fetchWeather_() {
  const c = campLocation_(), lat = c ? c.lat : 23.68, lng = c ? c.lng : 57.89;
  const res = UrlFetchApp.fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max&timezone=Asia%2FMuscat&forecast_days=16', { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('weather ' + res.getResponseCode());
  const d = JSON.parse(res.getContentText()).daily;
  if (!d || !d.time) throw new Error('weather: unexpected answer');
  const n = function(v) { return v === null || v === undefined ? 0 : Math.round(Number(v) * 10) / 10; };
  return { at: new Date().toISOString(), days: d.time.map(function(day, i) { return { date: day, code: d.weather_code[i], tmax: Math.round(n(d.temperature_2m_max[i])), tmin: Math.round(n(d.temperature_2m_min[i])), rain: Math.round(n(d.precipitation_probability_max[i])), mm: n(d.precipitation_sum[i]), wind: Math.round(n(d.wind_speed_10m_max[i])) }; }) };
}
function weatherCached_() {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('weather_v1'); if (hit) return JSON.parse(hit); } catch (e) { /* refetch */ }
  const props = PropertiesService.getScriptProperties();
  try {
    const w = fetchWeather_(); const txt = JSON.stringify(w);
    try { cache.put('weather_v1', txt, WEATHER_TTL_); } catch (e) { /* ignore */ }
    try { props.setProperty('WeatherLast', txt); } catch (e) { /* ignore */ }
    return w;
  } catch (err) {
    try { const old = JSON.parse(props.getProperty('WeatherLast') || 'null'); if (old) { old.old = true; try { cache.put('weather_v1', JSON.stringify(old), 600); } catch (e) { /* ignore */ } return old; } } catch (e) { /* none */ }
    return null;
  }
}
function handleWeather_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'stats']), function() { const w = weatherCached_(); return { success: true, weather: w }; });
}
// Run ONCE from the editor: it asks Google to allow the script to contact the weather service (needed once), and shows the answer in the log.
function ADMIN_testWeather() { const w = fetchWeather_(); Logger.log('الطقس يعمل: ' + w.days.length + ' يومًا. أول يوم: ' + JSON.stringify(w.days[0])); }

// ONE round trip for the whole leader screen (summary + buses + cases): authorises once instead of three times.
function handleLeaderAll_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'stats', 'livemap']), function(user) {
    const out = { success: true };
    if (hasPerm_(user, 'dashboard') || hasPerm_(user, 'stats')) out.summary = leaderSummaryCached_();
    if (hasPerm_(user, 'dashboard') || hasPerm_(user, 'livemap')) out.buses = liveBuses_();
    if (hasPerm_(user, 'dashboard') || hasPerm_(user, 'stats') || hasPerm_(user, 'manage')) out.cases = casesForList_();
    out.camp = campLocation_();
    if (hasPerm_(user, 'dashboard')) {
      const cache = CacheService.getScriptCache(); let ex = null;
      try { const hit = cache.get('leader_x1'); if (hit) ex = JSON.parse(hit); } catch (e) { ex = null; }
      if (!ex) { ex = leaderExtra_(); try { cache.put('leader_x1', JSON.stringify(ex), 10); } catch (e) { /* too large: skip */ } }
      out.extra = ex;
    }
    out.canSetCamp = hasPerm_(user, 'manage');
    return out;
  });
}

// ---------------- Bags (airport idea: load / unload counts) ----------------
function bagsSheet_() { return getSheetByName_('Bags'); }

function handleBag_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const mode = String(data.mode);
    if (['load', 'unload'].indexOf(mode) === -1) return { success: false, code: 'BAD_REQUEST', error: 'Invalid mode' };
    const count = Math.floor(Number(data.count));
    if (!isFinite(count) || count < 0 || count > MAX_BAGS) return { success: false, code: 'BAD_REQUEST', error: 'عدد غير صالح' };
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    if (!canRecordFor_(user, student)) return { success: false, code: 'OTHER_BUS', error: 'هذا الطالب ليس في باصك' };
    const clientId = String(data.clientId || '').slice(0, 60);
    bagsSheet_(); // C2: open the spreadsheet BEFORE taking the lock
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = bagsSheet_();
      const vals = sheet.getDataRange().getValues();
      const h = vals[0];
      const iC = h.indexOf('ClientId');
      if (clientId) for (let r = 1; r < vals.length; r++) if (String(vals[r][iC]) === clientId) return { success: true, repeated: true };
      appendSafe_(sheet, [new Date(), student.id, student.bus, mode, count, student.bags, user.Username, clientId]);
    } finally {
      lock.releaseLock();
    }
    return { success: true, expected: student.bags, mismatch: student.bags > 0 && mode === 'load' && count < student.bags };
  });
}

// ---------------- Leader summary (read-only) ----------------
function leaderSummaryCached_() {
  // The leader screen polls every 15 s: serve a 10 s cache (any write action clears it, see doPost).
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('leader_v1'); if (hit) return JSON.parse(hit); } catch (e) { /* recompute */ }
  const out = computeLeaderSummary_();
  try { cache.put('leader_v1', JSON.stringify(out), 10); } catch (e) { /* ignore */ }
  return out;
}
function handleLeaderSummary_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'stats']), function() { return leaderSummaryCached_(); });
}
function computeLeaderSummary_() {
  return (function() {
    const students = readStudents_().students;
    const sc = scanStates_();
    const buses = {};
    students.forEach(function(s) { if (s.bus) buses[s.bus] = true; }); // a student with no bus (came with his guardian) is not a "bus"
    const perBus = Object.keys(buses).sort().map(function(b) {
      const c = busCounts_(b, students, sc.states);
      let withGuardian = 0; students.forEach(function(s) { const x = sc.states[s.id]; if (s.bus === b && x && x.state === 'boarded' && x.via === 'guardian') withGuardian++; }); // came with the guardian, not on the bus (already counted in boarded)
      return { bus: b, total: c.total, boarded: c.boarded, missing: c.missing.length, guardian: withGuardian };
    });
    let withdrawn = 0;
    Object.keys(sc.states).forEach(function(k) { if (sc.states[k].state === 'withdrawn') withdrawn++; });
    // Present = everybody currently "in": by bus + direct (with a guardian / late). Each student is counted once.
    const total = students.length;
    let boarded = 0, direct = 0;
    students.forEach(function(s) { const x = sc.states[s.id]; if (x && x.state === 'boarded') { boarded++; if (x.via === 'guardian') direct++; } });
    // bags
    const bvals = bagsSheet_().getDataRange().getValues();
    const bh = bvals[0];
    let loaded = 0, unloaded = 0;
    const lastByKey = {};
    for (let r = 1; r < bvals.length; r++) lastByKey[bvals[r][bh.indexOf('StudentID')] + '|' + bvals[r][bh.indexOf('Mode')]] = Number(bvals[r][bh.indexOf('Count')]) || 0;
    Object.keys(lastByKey).forEach(function(k) { if (k.split('|')[1] === 'load') loaded += lastByKey[k]; else unloaded += lastByKey[k]; });
    return { success: true, total: total, boarded: boarded, direct: direct, viaBus: boarded - direct, withdrawn: withdrawn, perBus: perBus, bags: { loaded: loaded, unloaded: unloaded },
      alerts: buildAlerts_(perBus, students, lastByKey) };
  })();
}

// ---------------- Smart alerts (rules only, computed on the server) ----------------
const STALE_SEC = 300;
function buildAlerts_(perBus, students, lastByKey) {
  const alerts = [];
  const live = {};
  const lv = busLiveSheet_().getDataRange().getValues();
  const h = lv[0], now = Date.now();
  for (let r = 1; r < lv.length; r++) {
    const b = String(lv[r][h.indexOf('Bus')]); if (!b) continue;
    const u = lv[r][h.indexOf('UpdatedAt')];
    const t = u instanceof Date ? u.getTime() : new Date(u).getTime();
    live[b] = { status: String(lv[r][h.indexOf('Status')]), ageSec: Math.max(0, Math.round((now - t) / 1000)) };
  }
  perBus.forEach(function(p) {
    const l = live[p.bus];
    if (!l) { alerts.push({ type: 'no_report', level: 'info', bus: p.bus }); return; }
    if (l.status !== 'arrived' && l.ageSec > STALE_SEC) alerts.push({ type: 'stale', level: 'warn', bus: p.bus, ageSec: l.ageSec });
    if ((l.status === 'departed' || l.status === 'onway' || l.status === 'arrived') && p.missing > 0) alerts.push({ type: 'missing', level: 'bad', bus: p.bus, missing: p.missing });
  });
  const shortBags = {};
  students.forEach(function(s) {
    const c = lastByKey[s.id + '|load'];
    if (s.bags > 0 && c !== undefined && c < s.bags) shortBags[s.bus] = (shortBags[s.bus] || 0) + 1;
  });
  Object.keys(shortBags).forEach(function(b) { alerts.push({ type: 'bags', level: 'warn', bus: b, count: shortBags[b] }); });
  try { const rl = latestRounds_(); Object.keys(rl).forEach(function(b) { if (rl[b].absent > 0) alerts.push({ type: 'round_gap', level: 'bad', bus: b, count: rl[b].absent, phase: rl[b].phase }); }); } catch (e) { /* tab missing */ }
  const open = readCases_().filter(function(c) { return c.status === 'open'; }).length;
  if (open) alerts.push({ type: 'cases_open', level: 'warn', count: open });
  const wOpen = readWithdrawals_().filter(function(w) { return w.status === 'open'; }).length;
  const medUrgent = readMedCases_().filter(function(c) { return c.status === 'open' && c.severity === 'urgent'; }).length;
  if (medUrgent) alerts.push({ type: 'med_urgent', level: 'bad', count: medUrgent });
  if (wOpen) alerts.push({ type: 'withdraw_open', level: 'warn', count: wOpen });
  const rank = { bad: 0, warn: 1, info: 2 };
  alerts.sort(function(a, b) { return rank[a.level] - rank[b.level]; });
  return alerts;
}

// ---------------- Cases (raise an issue to the administration) ----------------
const CASE_TYPES = ['student', 'bus', 'lost', 'other'];
function casesSheet_() { return getSheetByName_('Cases'); }
function readCases_() {
  const v = casesSheet_().getDataRange().getValues();
  const h = v[0], out = [];
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id')) continue;
    out.push({ id: String(g('Id')), time: g('Time') instanceof Date ? g('Time').toISOString() : String(g('Time')), type: g('Type'), bus: String(g('Bus')), studentId: String(g('StudentID')),
      text: String(g('Text')), status: String(g('Status')), by: String(g('CreatedBy')), updatedBy: String(g('UpdatedBy')) });
  }
  return out;
}
function handleCreateCase_(data) {
  return withAuth_(data, requireAnyPerm_(['checkin', 'dashboard', 'manage', 'gate']), function(user) {
    const type = String(data.type || 'other');
    if (CASE_TYPES.indexOf(type) === -1) return { success: false, code: 'BAD_REQUEST', error: 'Invalid type' };
    const text = String(data.text || '').trim().slice(0, 300);
    if (text.length < 3) return { success: false, code: 'BAD_REQUEST', error: 'اكتب وصفاً مختصراً' };
    const clientId = String(data.clientId || '').slice(0, 60);
    let bus = String(data.bus || '').slice(0, 10);
    if (!hasPerm_(user, 'allbuses') && hasPerm_(user, 'checkin')) bus = String(user.AssignedBus || '');
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = casesSheet_();
      const v = sheet.getDataRange().getValues(), h = v[0];
      if (clientId) for (let r = 1; r < v.length; r++) if (String(v[r][h.indexOf('ClientId')]) === clientId) return { success: true, repeated: true, id: String(v[r][h.indexOf('Id')]) };
      const id = newId_('C');
      appendSafe_(sheet, [id, new Date(), type, bus, String(data.studentId || '').slice(0, 40), text, 'open', user.Username, '', clientId]);
      writeAudit_(user.Username, 'CASE_CREATED', id, type);
      return { success: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
}
function casesForList_() {
  const rank = { open: 0, ack: 1, closed: 2 };
  return readCases_().sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (a.time < b.time ? 1 : -1); }).slice(0, 100)
    .map(function(c) { c.byName = repUserName_(c.by); return c; }); // the reporter's full name (the screen shows who reported)
}
function handleListCases_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'stats', 'manage']), function() {
    return { success: true, cases: casesForList_() };
  });
}
// A supervisor sees ONLY the reports he sent himself (text + status), never others'.
function handleMyCases_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const mine = readCases_().filter(function(c) { return c.by === user.Username; })
      .sort(function(a, b) { return a.time < b.time ? 1 : -1; }).slice(0, 8)
      .map(function(c) { return { id: c.id, time: c.time, text: c.text, status: c.status }; });
    return { success: true, cases: mine };
  });
}
function handleUpdateCase_(data) {
  return withAuth_(data, requireAnyPerm_(['dashboard', 'manage']), function(user) {
    const status = String(data.status);
    if (['ack', 'closed'].indexOf(status) === -1) return { success: false, error: 'Invalid status' };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sheet = casesSheet_();
      const v = sheet.getDataRange().getValues(), h = v[0];
      for (let r = 1; r < v.length; r++) {
        if (String(v[r][h.indexOf('Id')]) === String(data.id)) {
          sheet.getRange(r + 1, h.indexOf('Status') + 1).setValue(status);
          sheet.getRange(r + 1, h.indexOf('UpdatedBy') + 1).setValue(user.Username);
          writeAudit_(user.Username, 'CASE_' + status.toUpperCase(), String(data.id), '');
          return { success: true };
        }
      }
      return { success: false, error: 'غير موجود' };
    } finally {
      lock.releaseLock();
    }
  });
}

// ---------------- Student movement history (no phone numbers) ----------------
function handleHistory_(data) {
  return withAuth_(data, requireAnyPerm_(['manage', 'dashboard']), function(user) {
    const st = findStudent_(data.studentId);
    if (!st) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const events = [];
    const sv = scansSheet_().getDataRange().getValues(), sh = sv[0];
    for (let r = 1; r < sv.length; r++) if (String(sv[r][sh.indexOf('StudentID')]) === st.id) {
      const t = sv[r][sh.indexOf('Time')];
      events.push({ time: t instanceof Date ? t.toISOString() : String(t), kind: String(sv[r][sh.indexOf('Action')]), bus: String(sv[r][sh.indexOf('Bus')]), by: String(sv[r][sh.indexOf('Supervisor')]), method: String(sv[r][sh.indexOf('Method')]) });
    }
    const bv = bagsSheet_().getDataRange().getValues(), bh = bv[0];
    for (let r = 1; r < bv.length; r++) if (String(bv[r][bh.indexOf('StudentID')]) === st.id) {
      const t = bv[r][bh.indexOf('Time')];
      events.push({ time: t instanceof Date ? t.toISOString() : String(t), kind: 'bags_' + bv[r][bh.indexOf('Mode')], bus: String(bv[r][bh.indexOf('Bus')]), by: String(bv[r][bh.indexOf('Supervisor')]), count: Number(bv[r][bh.indexOf('Count')]) });
    }
    events.sort(function(a, b) { return a.time < b.time ? -1 : 1; });
    writeAudit_(user.Username, 'VIEW_HISTORY', st.id, '');
    return { success: true, student: { id: st.id, name: st.name, team: st.team, bus: st.bus }, events: events };
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
    clearStudentsCache_();
    result = readStudents_();
  } catch (err) {
    report.ok = false;
    report.problems.push(String(err.message || err));
    return report;
  }
  const seen = {}, perBus = {}, dups = [], noBus = [];
  result.students.forEach(function(st) {
    if (seen[st.id]) dups.push(st.id); seen[st.id] = true;
    if (!st.bus && !st.manual) noBus.push('صف ' + st._row); // a student added at reception may come with his guardian (no bus)
    perBus[st.bus || '—'] = (perBus[st.bus || '—'] || 0) + 1;
  });
  if (dups.length) { report.ok = false; report.problems.push('أرقام طلاب مكررة: ' + dups.join(', ')); }
  const nameSeen = {}, sameName = [];
  result.students.forEach(function(st) { const k = normNameKey_(st.name).split(' ').sort().join(' '); if (!k) return; if (nameSeen[k]) sameName.push(st.name + ' (' + nameSeen[k] + ' / ' + st.id + ')'); else nameSeen[k] = st.id; });
  if (sameName.length) { report.ok = false; report.problems.push('أسماء طلاب مكررة: ' + sameName.slice(0, 15).join(', ') + (sameName.length > 15 ? ' …' : '')); }
  if (noBus.length) { report.ok = false; report.problems.push('طلاب بلا باص: ' + noBus.join(', ')); }
  if (result.cols.cls === -1) report.notes.push('عمود Class غير موجود (اختياري)');
  if (result.cols.photo === -1) report.notes.push('عمود Photo URL غير موجود (لازم للتعرف على الوجه)');
  if (result.cols.team === -1) report.notes.push('عمود Team name غير موجود (لازم للأساور)');
  const stages = readStages_();
  if (stages) {
    const noTime = stages.filter(function(x) { return !x.startMs; });
    if (noTime.length) { report.ok = false; report.problems.push('مرحلة بلا تاريخ أو وقت صحيح (Date بصيغة 2026-12-30 و From / To بصيغة 14:00): ' + noTime.map(function(x) { return x.name; }).join('، ')); }
    const noGrade = result.students.filter(function(st) { return gradeOf_(st.cls) === null; });
    if (noGrade.length) { report.ok = false; report.problems.push('طلاب صفّهم غير مفهوم (المراحل تعتمد على الصف): ' + noGrade.slice(0, 20).map(function(st) { return st.manual ? st.id : 'صف ' + st._row; }).join(', ') + (noGrade.length > 20 ? ' …' : '')); }
    const trip = result.students.filter(function(st) { return st.trip; });
    if (result.cols.trip === -1) report.notes.push('عمود «رحلة» غير موجود: لا أحد مسجّل في الرحلة الخارجية');
    else report.notes.push('المسجّلون في الرحلة الخارجية: ' + trip.length);
    for (let i = 0; i < stages.length; i++) for (let j = i + 1; j < stages.length; j++) { // two open windows that accept the same student would be ambiguous
      const A = stages[i], B = stages[j];
      if (A.startMs && B.startMs && A.startMs < B.endMs && B.startMs < A.endMs && result.students.some(function(st) { return stageIncludes_(A, st) && stageIncludes_(B, st); })) { report.ok = false; report.problems.push('مرحلتان تتداخل نافذتاهما وتضمّان نفس الطلاب: ' + A.name + ' و ' + B.name); }
    }
    const perStage = stages.map(function(x) { return x.name + ': ' + result.students.filter(function(st) { return stageIncludes_(x, st); }).length; });
    report.notes.push('عدد الطلاب في كل مرحلة — ' + perStage.join(' · '));
  }
  report.total = result.students.length;
  report.perBus = perBus;
  return report;
}

function ADMIN_checkStudentSheet() {
  Logger.log(JSON.stringify(checkStudentSheet_(), null, 2));
}

// ---------------- Verification round ("Round check"): the supervisor calls the names on the bus and confirms each one is really there ----------------
function roundsSheet_() { return getSheetByName_('Rounds'); }
// Latest round per bus: { bus: { phase, at, checked, absent, total, by } }
function latestRounds_() {
  const v = roundsSheet_().getDataRange().getValues(), h = v[0] || [], out = {};
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; }, b = String(g('Bus')); if (!b) continue;
    const t = g('Time');
    out[b] = { phase: String(g('Phase')), at: t instanceof Date ? t.toISOString() : String(t), checked: Number(g('Checked')) || 0, absent: Number(g('Absent')) || 0, total: Number(g('Total')) || 0, by: String(g('Supervisor')) };
  }
  return out;
}
function handleRoundSave_(data) {
  return withAuth_(data, requirePerm_('checkin'), function(user) {
    const phase = data.phase === 'arrive' ? 'arrive' : 'depart';
    const bus = hasPerm_(user, 'allbuses') && data.bus ? String(data.bus) : String(user.AssignedBus || '').trim();
    if (!bus) return { success: false, code: 'BAD_REQUEST', error: 'حسابك غير مرتبط بباص. يُرجى التواصل مع السكرتارية لتعيين باص لك' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const students = readStudents_().students, states = scanStates_().states;
    const boarded = students.filter(function(s) { return s.bus === bus && states[s.id] && states[s.id].state === 'boarded' && !states[s.id].via; }).map(function(s) { return s.id; });
    const absent = []; (Array.isArray(data.absent) ? data.absent : []).map(String).forEach(function(id) { if (boarded.indexOf(id) !== -1 && absent.indexOf(id) === -1) absent.push(id); });
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const v = roundsSheet_().getDataRange().getValues(), h = v[0] || [];
      if (clientId) for (let r = 1; r < v.length; r++) if (String(v[r][h.indexOf('ClientId')]) === clientId) return { success: true, repeated: true };
      appendSafe_(roundsSheet_(), [new Date(), bus, phase, user.FullName || user.Username, boarded.length - absent.length, absent.length, boarded.length, absent.join(','), clientId]);
      writeAudit_(user.Username, 'ROUND_SAVED', bus, phase + ' ' + (boarded.length - absent.length) + '/' + boarded.length);
      return { success: true, bus: bus, phase: phase, checked: boarded.length - absent.length, absent: absent.length, total: boarded.length, matched: absent.length === 0 };
    } finally {
      lock.releaseLock();
    }
  });
}
