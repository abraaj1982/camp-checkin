// =============================================================
// Doctors (medical cases) and Nutrition.
// PRIVACY: medical details are visible only with the 'medical' permission and are NEVER bulk-loaded:
// they are fetched one student at a time (medInfo), and every view is written to the audit log.
// Everyone else (leader, reports) sees COUNTS only. Nutrition sees ONLY food-allergy information.
// No phone numbers are returned by anything here.
// =============================================================

const MED_SEVERITY_ = ['normal', 'urgent'];
function medSheet_() { return getSheetByName_('MedicalCases'); }

function readMedCases_() {
  const v = medSheet_().getDataRange().getValues();
  const h = v[0] || [], out = [];
  const iso = function(t) { return t instanceof Date ? t.toISOString() : String(t || ''); };
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id')) continue;
    out.push({ id: String(g('Id')), studentId: String(g('StudentID')), openedAt: iso(g('OpenedAt')), openedBy: String(g('OpenedBy')), severity: String(g('Severity')),
      complaint: String(g('Complaint')), treatment: String(g('Treatment')), medication: String(g('Medication') || ''), status: String(g('Status')), closedAt: iso(g('ClosedAt')), closedBy: String(g('ClosedBy')), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}

function medStudentView_(s, cases) {
  const open = cases.filter(function(c) { return c.studentId === s.id && c.status === 'open'; })[0];
  return { id: s.id, name: s.name, team: s.team, bus: s.bus, cls: s.cls, age: s.age || '', hasNotes: !!(s.medical || s.foodAllergy), openCase: open ? open.id : null };
}

function handleMedFind_(data) {
  return withAuth_(data, requirePerm_('medical'), function() {
    const q = String(data.q === undefined ? '' : data.q).trim().toLowerCase();
    if (q.length < 1 || q.length > 60) return { success: true, results: [] };
    const cases = readMedCases_();
    const res = readStudents_().students.filter(function(s) { return s.id.toLowerCase() === q || s.id.indexOf(q) === 0 || (q.length >= 2 && s.name.toLowerCase().indexOf(q) !== -1); })
      .slice(0, 8).map(function(s) { return medStudentView_(s, cases); });
    return { success: true, results: res };
  });
}

// One student's protected notes (chronic conditions, allergies of any kind). Logged on every view.
function handleMedInfo_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const s = findStudent_(data.studentId);
    if (!s) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    writeAudit_(user.Username, 'MED_VIEW', s.id, '');
    return { success: true, id: s.id, notes: s.medical, foodAllergy: s.foodAllergy, dob: s.dob || '', age: s.age || '' };
  });
}

function handleMedOpen_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const s = findStudent_(data.studentId);
    if (!s) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const severity = String(data.severity || 'normal');
    if (MED_SEVERITY_.indexOf(severity) === -1) return { success: false, error: 'Invalid severity' };
    const complaint = String(data.complaint || '').trim().slice(0, 2000);
    if (complaint.length < 3) return { success: false, error: 'اكتب الشكوى' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const all = readMedCases_();
      if (clientId) { const dup = all.filter(function(c) { return c.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
      if (all.some(function(c) { return c.studentId === s.id && c.status === 'open'; })) return { success: false, code: 'ALREADY_OPEN', error: 'يوجد ملف مفتوح لهذا الطالب' };
      const id = newId_('M');
      appendSafe_(medSheet_(), [id, s.id, new Date(), user.Username, severity, complaint, '', 'open', '', '', clientId]);
      writeAudit_(user.Username, 'MED_OPENED', s.id, id);
      return { success: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
}

// The doctor's written parts: symptoms (Complaint), diagnosis (the Treatment column) and the medication given with its dose.
// The medication column is added by SETUP_createTabs; without it nothing is written silently, the doctor is told.
function medSetFields_(sheet, h, row, data) {
  const map = [['treatment', 'Treatment'], ['medication', 'Medication']];
  for (let i = 0; i < map.length; i++) {
    const v = data[map[i][0]]; if (v === undefined) continue;
    const col = h.indexOf(map[i][1]); const txt = String(v).trim().slice(0, 2000);
    if (col === -1) { if (txt) return { success: false, code: 'NEEDS_SETUP', error: 'يلزم تشغيل SETUP_createTabs مرة واحدة لإضافة أعمدة الدواء والتوصيات' }; continue; }
    sheet.getRange(row, col + 1).setValue(cellSafe_(txt));
  }
  return null;
}
function handleMedUpdate_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const c = readMedCases_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!c) return { success: false, error: 'غير موجود' };
      if (c.status !== 'open') return { success: false, code: 'NOT_OPEN', error: 'الملف مغلق' };
      const sheet = medSheet_(), h = sheet.getDataRange().getValues()[0];
      const missing = medSetFields_(sheet, h, c._row, data); if (missing) return missing;
      if (data.severity !== undefined && MED_SEVERITY_.indexOf(String(data.severity)) !== -1) sheet.getRange(c._row, h.indexOf('Severity') + 1).setValue(String(data.severity));
      writeAudit_(user.Username, 'MED_UPDATED', c.studentId, c.id);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleMedClose_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const c = readMedCases_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!c) return { success: false, error: 'غير موجود' };
      if (c.status !== 'open') return { success: false, code: 'NOT_OPEN', error: 'الملف مغلق' };
      const treatment = String(data.treatment !== undefined ? data.treatment : c.treatment).trim().slice(0, 2000);
      if (treatment.length < 2) return { success: false, code: 'TREATMENT_REQUIRED', error: 'اكتب التشخيص قبل الإغلاق' };
      const sheet = medSheet_(), h = sheet.getDataRange().getValues()[0];
      const missing = medSetFields_(sheet, h, c._row, { treatment: treatment, medication: data.medication }); if (missing) return missing;
      sheet.getRange(c._row, h.indexOf('Status') + 1).setValue('closed');
      sheet.getRange(c._row, h.indexOf('ClosedAt') + 1).setValue(new Date());
      sheet.getRange(c._row, h.indexOf('ClosedBy') + 1).setValue(user.Username);
      writeAudit_(user.Username, 'MED_CLOSED', c.studentId, c.id);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

// Case list WITH details: doctors only. Logged.
function handleMedList_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const byId = {};
    readStudents_().students.forEach(function(s) { byId[s.id] = s; });
    const rank = { open: 0, closed: 1 };
    const list = readMedCases_().sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (a.openedAt < b.openedAt ? 1 : -1); }).slice(0, 600).map(function(c) {
      const s = byId[c.studentId] || {};
      return { id: c.id, studentId: c.studentId, name: s.name || '', team: s.team || '', bus: s.bus || '', openedAt: c.openedAt, severity: c.severity, complaint: c.complaint,
        treatment: c.treatment, medication: c.medication, status: c.status, closedAt: c.closedAt, openedBy: c.openedBy, closedBy: c.closedBy, cls: s.cls || '', age: s.age || '', doctor: repUserName_(c.openedBy), closedByName: c.closedBy ? repUserName_(c.closedBy) : '' };
    });
    try { const ck = 'medlist_' + user.Username, cc = CacheService.getScriptCache(); if (!cc.get(ck)) { writeAudit_(user.Username, 'MED_LIST', '', 'n=' + list.length); cc.put(ck, '1', 600); } } catch (e) { /* the audit is best effort here */ }
    return { success: true, cases: list };
  });
}

// Counts only: safe for the leader and for reports. No names, no complaints, no treatments.
function handleMedStats_(data) {
  return withAuth_(data, requireAnyPerm_(['medical', 'dashboard', 'stats', 'manage']), function() {
    const byId = {};
    readStudents_().students.forEach(function(s) { byId[s.id] = s; });
    const cases = readMedCases_();
    const byDay = {}, byTeam = {}, byBus = {};
    let closed = 0, urgent = 0, mins = 0, minsN = 0;
    cases.forEach(function(c) {
      const day = c.openedAt.slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
      const s = byId[c.studentId];
      if (s) { byTeam[s.team || '—'] = (byTeam[s.team || '—'] || 0) + 1; byBus[s.bus || '—'] = (byBus[s.bus || '—'] || 0) + 1; }
      if (c.severity === 'urgent') urgent++;
      if (c.status === 'closed') {
        closed++;
        const d = (new Date(c.closedAt).getTime() - new Date(c.openedAt).getTime()) / 60000;
        if (isFinite(d) && d >= 0) { mins += d; minsN++; }
      }
    });
    const keys = function(o) { return Object.keys(o).sort().map(function(k) { return { key: k, count: o[k] }; }); };
    return { success: true, total: cases.length, open: cases.length - closed, closed: closed, urgent: urgent, avgCloseMinutes: minsN ? Math.round(mins / minsN) : 0,
      byDay: keys(byDay), byTeam: keys(byTeam), byBus: keys(byBus) };
  });
}

// ---------------- Nutrition ----------------
// Counts for meals (present = boarded and not withdrawn) + FOOD allergies by name. Nothing else about health.
function handleNutritionSummary_(data) {
  return withAuth_(data, requireAnyPerm_(['nutrition', 'dashboard', 'stats']), function(user) {
    const students = readStudents_().students;
    const states = scanStates_().states;
    const present = students.filter(function(s) { return states[s.id] && states[s.id].state === 'boarded'; });
    const byTeam = {};
    present.forEach(function(s) { byTeam[s.team || '—'] = (byTeam[s.team || '—'] || 0) + 1; });
    const users = readSheetAsObjects_(USERS_SHEET).rows.filter(function(r) { return r.Active === true && String(r.AssignedBus).trim() !== ''; });
    // Staff (cooks, committees, supervisors...) is typed by hand by the secretariat/nutrition, per day: a day without its own number
    // keeps the latest earlier one (then the general number); until anything is typed we use the bus-supervisor accounts.
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(data.day || '')) ? String(data.day) : new Date().toISOString().slice(0, 10);
    const sd = staffForDay_(day);
    const staffManual = sd.manual;
    const staff = staffManual ? sd.n : users.length;
    // Where the students are right now: only "boarded" eat at camp. The others are shown beside the number, not hidden.
    let awaiting = 0, onTrip = 0, gone = 0;
    students.forEach(function(s) { const st = states[s.id]; if (!st) awaiting++; else if (st.state === 'on_trip') onTrip++; else if (st.state === 'departed' || st.state === 'withdrawn') gone++; });
    const withAllergyAll = students.filter(function(s) { return s.foodAllergy; });
    const sig = allergySig_(withAllergyAll);
    let ack = null;
    try { ack = JSON.parse(String(getSetting_('NutritionAck') || '')); } catch (e) { ack = null; }
    const out = { success: true, studentsTotal: students.length, studentsPresent: present.length, supervisors: users.length,
      staff: staff, staffManual: staffManual, mealsToPrepare: present.length + staff, mealsExpected: students.length + staff,
      staffDay: sd.dayOwn, awaiting: awaiting, onTrip: onTrip, gone: gone, meals: nextMeals_(day), serverTime: new Date().toISOString(),
      allergyCount: withAllergyAll.length,
      ack: ack ? { by: ack.by, at: ack.at, current: ack.sig === sig } : null,
      byTeam: Object.keys(byTeam).sort().map(function(k) { return { team: k, count: byTeam[k] }; }) };
    if (hasPerm_(user, 'nutrition')) {
      const withAllergy = students.filter(function(s) { return s.foodAllergy; });
      out.allergyColumnPresent = readStudents_().cols.foodAllergy !== -1;
      out.allergies = withAllergy.map(function(s) {
        const st = states[s.id];
        return { id: s.id, name: s.name, team: s.team, allergy: s.foodAllergy, present: !!(st && st.state === 'boarded') };
      });
      writeAudit_(user.Username, 'NUTRITION_VIEW', '', 'allergies=' + withAllergy.length);
    }
    return out;
  });
}

// The latest staff number typed for a day on or before `day` ("StaffCount_YYYY-MM-DD"), else the general "StaffCount".
function staffForDay_(day) {
  let best = '', bestV = null;
  readSheetAsObjects_(SETTINGS_SHEET).rows.forEach(function(r) {
    const k = String(r.Key || '');
    if (k.indexOf('StaffCount_') === 0 && k.slice(11) <= day && k.slice(11) > best && String(r.Value).trim() !== '' && isFinite(Number(r.Value))) { best = k.slice(11); bestV = Number(r.Value); }
  });
  if (bestV !== null) return { n: Math.max(0, Math.round(bestV)), manual: true, dayOwn: best === day };
  const g = getSetting_('StaffCount');
  if (g !== null && String(g).trim() !== '' && isFinite(Number(g))) return { n: Math.max(0, Math.round(Number(g))), manual: true, dayOwn: false };
  return { n: 0, manual: false, dayOwn: false };
}
// The meals of the camp program (type "وجبة") for today and tomorrow: one per day and kind (breakfast / lunch / dinner), the latest time of the kind.
function nextMeals_(day) {
  const t = new Date(day + 'T12:00:00'); t.setDate(t.getDate() + 1);
  const tomorrow = t.getFullYear() + '-' + ('0' + (t.getMonth() + 1)).slice(-2) + '-' + ('0' + t.getDate()).slice(-2);
  const best = {};
  try {
    readProgram_().forEach(function(x) {
      if (x.type !== 'وجبة' || (x.date !== day && x.date !== tomorrow)) return;
      const kind = /إفطار|فطور/.test(x.title) ? 'الإفطار' : /غداء/.test(x.title) ? 'الغداء' : /عشاء/.test(x.title) ? 'العشاء' : x.title;
      const k = x.date + '|' + kind;
      if (!best[k] || x.from > best[k].from) best[k] = { date: x.date, from: x.from, name: kind };
    });
  } catch (e) { return []; }
  return Object.keys(best).map(function(k) { return best[k]; }).sort(function(a, b) { return (a.date + a.from) < (b.date + b.from) ? -1 : 1; });
}

function allergySig_(list) {
  const str = list.map(function(s) { return s.id + '|' + s.foodAllergy; }).sort().join(';');
  let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return String(h) + ':' + list.length;
}

// The nutrition committee confirms it received the current allergy list. If the list changes later, the confirmation is no longer "current".
function handleNutritionAck_(data) {
  return withAuth_(data, requirePerm_('nutrition'), function(user) {
    const list = readStudents_().students.filter(function(s) { return s.foodAllergy; });
    const at = new Date().toISOString();
    setSetting_('NutritionAck', JSON.stringify({ by: user.FullName || user.Username, at: at, sig: allergySig_(list) }));
    writeAudit_(user.Username, 'NUTRITION_ACK', '', 'allergies=' + list.length);
    return { success: true, ack: { by: user.FullName || user.Username, at: at, current: true } };
  });
}

// Number of staff (not students): typed by hand.
function handleNutritionSetStaff_(data) {
  return withAuth_(data, requireAnyPerm_(['nutrition', 'manage']), function(user) {
    const n = Number(data.count);
    if (!isFinite(n) || n < 0 || n > 5000) return { success: false, error: 'رقم غير صالح' };
    const day = String(data.day || '');
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { success: false, error: 'Invalid request' };
    setSetting_(day ? 'StaffCount_' + day : 'StaffCount', Math.round(n));
    writeAudit_(user.Username, 'STAFF_COUNT_SET', day, String(Math.round(n)));
    return { success: true, staff: Math.round(n) };
  });
}
