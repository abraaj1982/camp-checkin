// =============================================================
// Reception (secretariat desk):
//  1) A student who comes WITH his guardian (not by bus): record his arrival and the guardian's name.
//  2) New Student (separate screen, permission "addstudent", secretariat/admin only, never a bus supervisor): a student who is NOT in the
//     registration sheet is added by hand; he joins the normal lists, wristbands and reports.
// Late students live in the "ExtraStudents" tab of the main sheet, so replacing the registration sheet never loses them.
// =============================================================
const EXTRA_SHEET_ = 'ExtraStudents';

function extraSheet_() { return getSheetByName_(EXTRA_SHEET_); }
function readExtraStudents_() {
  let v; try { v = extraSheet_().getDataRange().getValues(); } catch (e) { return []; }
  const h = v[0] || [], out = [];
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id') || g('Active') === false) continue;
    out.push({ id: String(g('Id')).trim(), name: String(g('Name')).trim(), team: String(g('Team') || '').trim(), bus: String(g('Bus') || '').trim(), cls: String(g('Class') || '').trim(),
      photo: '', shirt: String(g('Shirt') || '').trim(), bags: Number(g('Bags')) || 0, foodAllergy: realValue_(g('FoodAllergy')), medical: realValue_(g('Medical')), trip: isYes_(g('Trip')), manual: true, note: String(g('Note') || ''), addedAt: isoOf_(g('AddedAt')), addedBy: String(g('AddedBy') || ''), clientId: String(g('ClientId') || ''), _row: r + 1 });
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

function cleanNote_(s, n) { return String(s || '').replace(/[()\n\r|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n); } // free text (father, uncle Salim...): no brackets, so the stored line stays parseable
function guardianNote_(name, relation) { return 'ولي الأمر: ' + cleanNote_(name, 60) + (relation ? ' (' + relation + ')' : ''); }
function parseGuardian_(note) { const m = String(note || '').match(/^ولي الأمر: ([^(]*?)(?: \(([^)]*)\))?$/); return m ? { name: m[1], relation: m[2] || '' } : { name: '', relation: '' }; }

function handleReceptionArrive_(data) {
  return withAuth_(data, requirePerm_('reception'), function(user) {
    const student = findStudent_(data.studentId);
    if (!student) return { success: false, code: 'NOT_FOUND', error: 'الطالب غير موجود' };
    const name = cleanNote_(data.guardian, 60);
    if (name.length < 3) return { success: false, code: 'BAD_REQUEST', error: 'اكتب اسم ولي الأمر' };
    const relation = cleanNote_(data.relation, 40); // a free note: father, uncle, maternal uncle...
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
    return { success: true, arrivals: arrivals };
  });
}

// ---- New Student screen (permission 'addstudent'; a bus supervisor is refused even if the permission was ticked by mistake)
function requireAddStudent_(user) { return hasPerm_(user, 'addstudent') && !String(user.AssignedBus || '').trim(); }
function handleStudentAddList_(data) {
  return withAuth_(data, requireAddStudent_, function() {
    const added = readExtraStudents_().map(function(s) { return { id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus, shirt: s.shirt, trip: s.trip, note: s.note, addedAt: s.addedAt, addedBy: repUserName_(s.addedBy) }; }).sort(function(a, b) { return a.addedAt < b.addedAt ? 1 : -1; });
    const all = readStudents_().students, uniq = function(k) { const m = {}; all.forEach(function(s) { if (s[k]) m[s[k]] = 1; }); return Object.keys(m).sort(repNum_); };
    return { success: true, added: added, teams: uniq('team'), buses: uniq('bus'), classes: uniq('cls') };
  });
}


// ---- Names: a student is NEVER added twice, for any reason (no override). Two names clash when, after removing diacritics,
// tatweel and spelling variants (أإآ/ى/ة/ؤئ), they are equal, hold the same words in another order, or differ by one letter (typo).
function normNameKey_(s) {
  return String(s || '').toLowerCase().replace(/[\u0610-\u061A\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\u0621-\u064Aa-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function oneEditApart_(a, b) {
  if (a === b) return true; const la = a.length, lb = b.length; if (Math.abs(la - lb) > 1) return false;
  let i = 0; while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) return a.slice(i + 1) === b.slice(i + 1);
  return la < lb ? a.slice(i) === b.slice(i + 1) : a.slice(i + 1) === b.slice(i);
}
function nameClash_(all, name) {
  const k = normNameKey_(name); if (!k) return null; const tok = k.split(' ').sort().join(' ');
  return all.filter(function(s) { const o = normNameKey_(s.name); return o === k || o.split(' ').sort().join(' ') === tok || (k.length >= 8 && oneEditApart_(o, k)); })[0] || null;
}

function handleStudentAdd_(data) {
  return withAuth_(data, requireAddStudent_, function(user) {
    const name = String(data.name || '').trim().slice(0, 60);
    if (name.length < 3) return { success: false, code: 'BAD_REQUEST', error: 'اكتب اسم الطالب كاملًا' };
    const cls = String(data.cls || '').trim().slice(0, 10);
    if (!cls || gradeOf_(cls) === null) return { success: false, code: 'BAD_REQUEST', error: 'اختر الصف (تعتمد عليه المراحل)' };
    const trip = isYes_(data.trip), food = cleanNote_(data.foodAllergy, 100), medical = cleanNote_(data.medical, 100), bags = Math.max(0, Math.min(20, Math.floor(Number(data.bags) || 0)));
    const bus = String(data.bus || '').trim().slice(0, 10), shirt = normSize_(data.shirt).slice(0, 8), note = String(data.note || '').trim().slice(0, 100);
    const team = String(data.team || '').trim().slice(0, 40);
    const teams = {}; readStudents_().students.forEach(function(s) { if (s.team) teams[s.team] = 1; });
    if (team && !teams[team]) return { success: false, code: 'BAD_REQUEST', error: 'فريق غير معروف' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const extra = readExtraStudents_();
      if (clientId) { const dup = extra.filter(function(x) { return x.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id, name: dup.name }; }
      // Everything below uses a FRESH read made inside the lock (never the shared cache, which may be up to a minute old):
      // the registration sheet AND every hand-added student, so a number is never given twice.
      const all = readStudents_(true).students;
      // The bus must be one of the buses of the registration sheet (the screen offers only those; the server now checks too).
      // An empty bus stays allowed: a student who comes with his guardian may have no bus.
      if (bus && !all.some(function(s) { return !s.manual && s.bus === bus; })) return { success: false, code: 'BAD_REQUEST', error: 'باص غير موجود' };
      const same = nameClash_(all, name); // no override: the student already exists, open him instead of adding him again
      if (same) return { success: false, code: 'DUPLICATE_NAME', error: 'هذا الطالب مسجّل مسبقًا. لا يمكن إضافته مرة ثانية.', existing: { id: same.id, name: same.name, team: same.team, bus: same.bus, cls: same.cls, manual: !!same.manual } };
      const taken = {}; let n = 0;
      all.concat(extra).forEach(function(s) { taken[s.id] = true; const m = /^X(\d+)$/.exec(s.id); if (m) n = Math.max(n, Number(m[1])); });
      let id = 'X' + (n + 1); while (taken[id]) { n++; id = 'X' + (n + 1); }
      appendSafe_(extraSheet_(), [id, name, cls, team, bus, shirt, note, new Date(), user.Username, true, clientId, trip ? 'نعم' : '', food, medical, bags || '']);
      clearStudentsCache_(); // every screen sees the new student at once
      writeAudit_(user.Username, 'STUDENT_ADDED', id, 'bus=' + bus);
      return { success: true, id: id, name: name };
    } finally {
      lock.releaseLock();
    }
  });
}
