// =============================================================
// Reception (secretariat desk):
//  1) A student who comes WITH his guardian (not by bus): record his arrival and the guardian's name.
//  2) A student who registers late (e.g. two days before): add him by hand; he joins the normal lists, wristbands and reports.
// Late students live in the "ExtraStudents" tab of the main sheet, so replacing the registration sheet never loses them.
// =============================================================
const EXTRA_SHEET_ = 'ExtraStudents';
const GUARDIAN_RELATIONS_ = ['father', 'mother', 'brother', 'sister', 'relative', 'other'];

function extraSheet_() { return getSheetByName_(EXTRA_SHEET_); }
function readExtraStudents_() {
  let v; try { v = extraSheet_().getDataRange().getValues(); } catch (e) { return []; }
  const h = v[0] || [], out = [];
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id') || g('Active') === false) continue;
    out.push({ id: String(g('Id')).trim(), name: String(g('Name')).trim(), team: String(g('Team') || '').trim(), bus: String(g('Bus') || '').trim(), cls: String(g('Class') || '').trim(),
      photo: '', shirt: String(g('Shirt') || '').trim(), bags: 0, foodAllergy: '', medical: '', manual: true, note: String(g('Note') || ''), addedAt: isoOf_(g('AddedAt')), addedBy: String(g('AddedBy') || ''), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}

function handleReceptionFind_(data) {
  return withAuth_(data, requirePerm_('reception'), function() {
    const q = String(data.q || '').trim().toLowerCase();
    if (q.length < 1) return { success: true, results: [] };
    const states = scanStates_().states;
    const res = readStudents_().students.filter(function(s) { return s.id.toLowerCase() === q || s.name.toLowerCase().indexOf(q) !== -1; }).slice(0, 12).map(function(s) {
      const st = states[s.id], o = publicStudent_(s, st, false); o.manual = !!s.manual; o.arrival = st && st.state === 'boarded' ? (st.via === 'guardian' ? 'guardian' : 'bus') : ''; return o; });
    return { success: true, results: res };
  });
}

function guardianNote_(name, relation) { return 'ولي الأمر: ' + name + (relation ? ' (' + relation + ')' : ''); }
function parseGuardian_(note) { const m = String(note || '').match(/^ولي الأمر: ([^(]*?)(?: \(([^)]*)\))?$/); return m ? { name: m[1], relation: m[2] || '' } : { name: '', relation: '' }; }

function handleReceptionArrive_(data) {
  return withAuth_(data, requirePerm_('reception'), function(user) {
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const name = String(data.guardian || '').trim().slice(0, 60);
    if (name.length < 3) return { success: false, code: 'BAD_REQUEST', error: 'اكتب اسم ولي الأمر' };
    const relation = GUARDIAN_RELATIONS_.indexOf(String(data.relation)) !== -1 ? String(data.relation) : '';
    const clientId = String(data.clientId || '').slice(0, 60);
    scansSheet_(); // C2: open the spreadsheet BEFORE taking the lock
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sc = scanStates_();
      if (clientId && sc.clients[clientId]) return { success: true, repeated: true };
      const cur = sc.states[student.id];
      if (cur && cur.state === 'boarded') return { success: false, code: 'DUPLICATE', error: cur.via === 'guardian' ? 'سُجّل دخوله مسبقاً مع ولي أمره' : 'سُجّل صعوده الباص مسبقاً', at: fmtTime_(cur.at), via: cur.via || 'bus', student: publicStudent_(student, cur, false) };
      if (cur && cur.state === 'withdrawn') return { success: false, code: 'WITHDRAWN', error: 'الطالب خرج بإذن' };
      appendSafe_(scansSheet_(), [new Date(), student.id, 'board', student.bus, user.Username, 'guardian', clientId, guardianNote_(name, relation)]);
      writeAudit_(user.Username, 'RECEPTION_ARRIVAL', student.id, 'guardian');
      return { success: true, student: publicStudent_(student, scanStates_().states[student.id], false) };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleReceptionUndo_(data) {
  return withAuth_(data, requirePerm_('reception'), function(user) {
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    scansSheet_(); // C2: open the spreadsheet BEFORE taking the lock
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cur = scanStates_().states[student.id];
      if (!cur || cur.state !== 'boarded' || cur.via !== 'guardian') return { success: false, code: 'NOTHING_TO_UNDO', error: 'لا يوجد دخول مع ولي أمر للتراجع عنه' };
      appendSafe_(scansSheet_(), [new Date(), student.id, 'undo', student.bus, user.Username, 'guardian', '', '']);
      writeAudit_(user.Username, 'RECEPTION_UNDO', student.id, '');
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleReceptionList_(data) {
  return withAuth_(data, requirePerm_('reception'), function() {
    const states = scanStates_().states, byId = {};
    readStudents_().students.forEach(function(s) { byId[s.id] = s; });
    const arrivals = [];
    Object.keys(states).forEach(function(id) {
      const st = states[id]; if (st.state !== 'boarded' || st.via !== 'guardian' || !byId[id]) return;
      const g = parseGuardian_(st.note), s = byId[id];
      arrivals.push({ id: id, name: s.name, team: s.team, cls: s.cls, bus: s.bus, at: st.at.toISOString(), by: repUserName_(st.by), guardian: g.name, relation: g.relation });
    });
    arrivals.sort(function(a, b) { return a.at < b.at ? 1 : -1; });
    const added = readExtraStudents_().map(function(s) { return { id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus, shirt: s.shirt, note: s.note, addedAt: s.addedAt, addedBy: repUserName_(s.addedBy) }; }).sort(function(a, b) { return a.addedAt < b.addedAt ? 1 : -1; });
    const all = readStudents_().students, uniq = function(k) { const m = {}; all.forEach(function(s) { if (s[k]) m[s[k]] = 1; }); return Object.keys(m).sort(repNum_); };
    return { success: true, arrivals: arrivals, added: added, teams: uniq('team'), buses: uniq('bus'), classes: uniq('cls') };
  });
}

function handleReceptionAdd_(data) {
  return withAuth_(data, requirePerm_('reception'), function(user) {
    const name = String(data.name || '').trim().slice(0, 60);
    if (name.length < 3) return { success: false, code: 'BAD_REQUEST', error: 'اكتب اسم الطالب كاملًا' };
    const cls = String(data.cls || '').trim().slice(0, 10), bus = String(data.bus || '').trim().slice(0, 10), shirt = normSize_(data.shirt).slice(0, 8), note = String(data.note || '').trim().slice(0, 100);
    const team = String(data.team || '').trim().slice(0, 40);
    const teams = {}; readStudents_().students.forEach(function(s) { if (s.team) teams[s.team] = 1; });
    if (team && !teams[team]) return { success: false, code: 'BAD_REQUEST', error: 'فريق غير معروف' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const extra = readExtraStudents_();
      if (clientId) { const dup = extra.filter(function(x) { return x.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id, name: dup.name }; }
      const same = readStudents_().students.filter(function(s) { return s.name === name; })[0];
      if (same && !data.confirmDuplicate) return { success: false, code: 'POSSIBLE_DUPLICATE', error: 'يوجد طالب بنفس الاسم', existing: { id: same.id, name: same.name, team: same.team, bus: same.bus, cls: same.cls } };
      let n = 0; readStudents_().students.forEach(function(s) { const m = /^X(\d+)$/.exec(s.id); if (m) n = Math.max(n, Number(m[1])); });
      const id = 'X' + (n + 1);
      appendSafe_(extraSheet_(), [id, name, cls, team, bus, shirt, note, new Date(), user.Username, true, clientId]);
      try { CacheService.getScriptCache().remove('students_v2'); } catch (e) { /* ignore */ }
      writeAudit_(user.Username, 'STUDENT_ADDED', id, 'bus=' + bus);
      return { success: true, id: id, name: name };
    } finally {
      lock.releaseLock();
    }
  });
}
