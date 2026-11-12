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
      complaint: String(g('Complaint')), treatment: String(g('Treatment')), status: String(g('Status')), closedAt: iso(g('ClosedAt')), closedBy: String(g('ClosedBy')), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}

function medStudentView_(s, cases) {
  const open = cases.filter(function(c) { return c.studentId === s.id && c.status === 'open'; })[0];
  return { id: s.id, name: s.name, team: s.team, bus: s.bus, cls: s.cls, hasNotes: !!(s.medical || s.foodAllergy), openCase: open ? open.id : null };
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
    return { success: true, id: s.id, notes: s.medical, foodAllergy: s.foodAllergy };
  });
}

function handleMedOpen_(data) {
  return withAuth_(data, requirePerm_('medical'), function(user) {
    const s = findStudent_(data.studentId);
    if (!s) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const severity = String(data.severity || 'normal');
    if (MED_SEVERITY_.indexOf(severity) === -1) return { success: false, error: 'Invalid severity' };
    const complaint = String(data.complaint || '').trim().slice(0, 500);
    if (complaint.length < 3) return { success: false, error: 'اكتب الشكوى' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const all = readMedCases_();
      if (clientId) { const dup = all.filter(function(c) { return c.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
      if (all.some(function(c) { return c.studentId === s.id && c.status === 'open'; })) return { success: false, code: 'ALREADY_OPEN', error: 'يوجد ملف مفتوح لهذا الطالب' };
      const id = newId_('M');
      medSheet_().appendRow([id, s.id, new Date(), user.Username, severity, complaint, '', 'open', '', '', clientId]);
      writeAudit_(user.Username, 'MED_OPENED', s.id, id);
      return { success: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
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
      if (data.treatment !== undefined) sheet.getRange(c._row, h.indexOf('Treatment') + 1).setValue(String(data.treatment).trim().slice(0, 800));
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
      const treatment = String(data.treatment !== undefined ? data.treatment : c.treatment).trim().slice(0, 800);
      if (treatment.length < 2) return { success: false, code: 'TREATMENT_REQUIRED', error: 'اكتب العلاج أو الإجراء قبل الإغلاق' };
      const sheet = medSheet_(), h = sheet.getDataRange().getValues()[0];
      sheet.getRange(c._row, h.indexOf('Treatment') + 1).setValue(treatment);
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
    const list = readMedCases_().sort(function(a, b) { return (rank[a.status] - rank[b.status]) || (a.openedAt < b.openedAt ? 1 : -1); }).slice(0, 100).map(function(c) {
      const s = byId[c.studentId] || {};
      return { id: c.id, studentId: c.studentId, name: s.name || '', team: s.team || '', bus: s.bus || '', openedAt: c.openedAt, severity: c.severity, complaint: c.complaint,
        treatment: c.treatment, status: c.status, closedAt: c.closedAt, openedBy: c.openedBy, closedBy: c.closedBy };
    });
    writeAudit_(user.Username, 'MED_LIST', '', 'n=' + list.length);
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
    const out = { success: true, studentsTotal: students.length, studentsPresent: present.length, supervisors: users.length,
      mealsToPrepare: present.length + users.length,
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
