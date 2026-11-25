// =============================================================
// Media committee: announcements, events (countdown) and competition results.
// - Staff bulletin: every signed-in user sees published items (action 'bulletin').
// - Public feed for the separate display-screen project: action 'feed' with a READ-ONLY key.
//   The feed contains ONLY published public items. Never any student, medical or contact data.
// Workflow: announcements need 'announce'; results are entered with 'results' and published with 'verify'.
// =============================================================

// announce = ticker/slide, event = countdown, urgent = full-screen emergency message, wisdom = حكمة اليوم,
// kudos = موقف اليوم, quote = قالوا عن المخيم, call = استدعاء طالب (by number only), greeting = عبارة الترحيب,
// finale = الحفل الختامي (countdown + festive theme on its day), other.
const ANN_KINDS_ = ['announce', 'event', 'finale', 'urgent', 'wisdom', 'kudos', 'quote', 'call', 'greeting', 'other'];
const DISPLAY_THEMES_ = ['auto', 'brand', 'jumuah', 'festive', 'night']; // 'auto' = brand by day, Thursday night, closing day, quiet night
const ANN_AUDIENCE_ = ['public', 'staff'];
function annSheet_() { return getSheetByName_('Announcements'); }
function resultsSheet_() { return getSheetByName_('Results'); }

function isoOf_(t) { return t instanceof Date ? t.toISOString() : String(t || ''); }

function readAnnouncements_() {
  const v = annSheet_().getDataRange().getValues();
  const h = v[0] || [], out = [];
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id')) continue;
    out.push({ id: String(g('Id')), createdAt: isoOf_(g('CreatedAt')), title: String(g('Title')), body: String(g('Body')), kind: String(g('Kind')), startsAt: isoOf_(g('StartsAt')),
      audience: String(g('Audience')), pinned: g('Pinned') === true, status: String(g('Status')), by: String(g('CreatedBy')), publishedAt: isoOf_(g('PublishedAt')), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}

function readResults_() {
  const v = resultsSheet_().getDataRange().getValues();
  const h = v[0] || [], out = [];
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { return v[r][h.indexOf(n)]; };
    if (!g('Id')) continue;
    out.push({ id: String(g('Id')), createdAt: isoOf_(g('CreatedAt')), competition: String(g('Competition')), team: String(g('Team')), place: g('Place') === '' ? null : Number(g('Place')),
      points: g('Points') === '' ? null : Number(g('Points')), status: String(g('Status')), by: String(g('CreatedBy')), publishedAt: isoOf_(g('PublishedAt')), clientId: String(g('ClientId') || ''), _row: r + 1 });
  }
  return out;
}

function setCell_(sheet, rowNum, colName, value) {
  const h = sheet.getDataRange().getValues()[0];
  sheet.getRange(rowNum, h.indexOf(colName) + 1).setValue(cellSafe_(value));
}

function handleMediaList_(data) {
  return withAuth_(data, requireAnyPerm_(['announce', 'results', 'verify']), function() {
    const rank = { draft: 0, published: 1, archived: 2 };
    const sortFn = function(a, b) { return (rank[a.status] - rank[b.status]) || (a.createdAt < b.createdAt ? 1 : -1); };
    return { success: true, announcements: readAnnouncements_().sort(sortFn).slice(0, 100), results: readResults_().sort(sortFn).slice(0, 300),
      campStart: String(getSetting_('CampStart') || '2026-12-30'), teams: teamsList_() };
  });
}

function handleAnnSave_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const title = String(data.title || '').trim().slice(0, 100);
    const body = String(data.body || '').trim().slice(0, 600);
    const kind = String(data.kind || 'announce'), audience = String(data.audience || 'public');
    if (title.length < 3) return { success: false, error: 'اكتب عنواناً' };
    if (ANN_KINDS_.indexOf(kind) === -1 || ANN_AUDIENCE_.indexOf(audience) === -1) return { success: false, error: 'Invalid request' };
    let startsAt = '';
    if (kind === 'event' || kind === 'finale') {
      const d = new Date(String(data.startsAt || ''));
      if (isNaN(d.getTime())) return { success: false, error: 'حدّد موعد الفعالية' };
      startsAt = d;
    }
    const pinned = data.pinned === true;
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const all = readAnnouncements_();
      if (data.id) {
        const a = all.filter(function(x) { return x.id === String(data.id); })[0];
        if (!a) return { success: false, error: 'غير موجود' };
        const sh = annSheet_();
        setCell_(sh, a._row, 'Title', title); setCell_(sh, a._row, 'Body', body); setCell_(sh, a._row, 'Kind', kind);
        setCell_(sh, a._row, 'StartsAt', startsAt); setCell_(sh, a._row, 'Audience', audience); setCell_(sh, a._row, 'Pinned', pinned);
        writeAudit_(user.Username, 'ANN_EDITED', a.id, '');
        return { success: true, id: a.id };
      }
      if (clientId) { const dup = all.filter(function(x) { return x.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
      const id = newId_('A');
      appendSafe_(annSheet_(), [id, new Date(), title, body, kind, startsAt, audience, pinned, 'draft', user.Username, '', clientId]);
      writeAudit_(user.Username, 'ANN_CREATED', id, kind);
      return { success: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleAnnStatus_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const status = String(data.status);
    if (['draft', 'published', 'archived'].indexOf(status) === -1) return { success: false, error: 'Invalid status' };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const a = readAnnouncements_().filter(function(x) { return x.id === String(data.id); })[0];
      if (!a) return { success: false, error: 'غير موجود' };
      const sh = annSheet_();
      setCell_(sh, a._row, 'Status', status);
      if (status === 'published') setCell_(sh, a._row, 'PublishedAt', new Date());
      writeAudit_(user.Username, 'ANN_' + status.toUpperCase(), a.id, a.audience);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  });
}

function handleResSave_(data) {
  return withAuth_(data, requireAnyPerm_(['results', 'verify']), function(user) {
    const competition = String(data.competition || '').trim().slice(0, 60);
    const team = String(data.team || '').trim().slice(0, 40);
    if (competition.length < 2) return { success: false, error: 'اكتب اسم المسابقة' };
    if (team.length < 1) return { success: false, error: 'اكتب اسم الفريق' };
    let place = '', points = '';
    if (data.place !== undefined && data.place !== null && data.place !== '') { place = Math.floor(Number(data.place)); if (!isFinite(place) || place < 1 || place > 99) return { success: false, error: 'المركز غير صالح' }; }
    if (data.points !== undefined && data.points !== null && data.points !== '') { points = Number(data.points); if (!isFinite(points) || points < 0 || points > 100000) return { success: false, error: 'النقاط غير صالحة' }; }
    if (place === '' && points === '') return { success: false, error: 'أدخل المركز أو النقاط' };
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const all = readResults_();
      if (clientId) { const dup = all.filter(function(x) { return x.clientId === clientId; })[0]; if (dup) return { success: true, repeated: true, id: dup.id }; }
      const id = newId_('R');
      appendSafe_(resultsSheet_(), [id, new Date(), competition, team, place, points, 'draft', user.Username, '', clientId]);
      writeAudit_(user.Username, 'RESULT_ENTERED', id, competition);
      return { success: true, id: id };
    } finally {
      lock.releaseLock();
    }
  });
}

// Publishing results needs 'verify' (a second pair of eyes). Archiving/returning to draft needs results or verify.
function handleResStatus_(data) {
  return withAuth_(data, requireAnyPerm_(['results', 'verify']), function(user) {
    const status = String(data.status);
    if (['draft', 'published', 'archived'].indexOf(status) === -1) return { success: false, error: 'Invalid status' };
    if (status === 'published' && !hasPerm_(user, 'verify')) return { success: false, code: 'NEEDS_VERIFY', error: 'النشر يحتاج صلاحية التحقق من النتائج' };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const ids = (Array.isArray(data.ids) ? data.ids : [data.id]).map(String).slice(0, 100);
      const all = readResults_();
      const sh = resultsSheet_();
      let n = 0;
      ids.forEach(function(id) {
        const r = all.filter(function(x) { return x.id === id; })[0];
        if (!r) return;
        setCell_(sh, r._row, 'Status', status);
        if (status === 'published') setCell_(sh, r._row, 'PublishedAt', new Date());
        n++;
      });
      if (!n) return { success: false, error: 'غير موجود' };
      writeAudit_(user.Username, 'RESULT_' + status.toUpperCase(), ids.join(',').slice(0, 100), 'n=' + n);
      return { success: true, changed: n };
    } finally {
      lock.releaseLock();
    }
  });
}

function publicAnnouncements_(audiences) {
  return readAnnouncements_().filter(function(a) { return a.status === 'published' && audiences.indexOf(a.audience) !== -1; })
    .sort(function(a, b) { return (b.pinned - a.pinned) || (a.publishedAt < b.publishedAt ? 1 : -1); })
    .map(function(a) { return { id: a.id, title: a.title, body: a.body, kind: a.kind, startsAt: a.startsAt, pinned: a.pinned, publishedAt: a.publishedAt, audience: a.audience }; });
}

// Any signed-in user: staff bulletin (published public + staff items).
function handleBulletin_(data) {
  return withAuth_(data, function() { return true; }, function() {
    return { success: true, items: publicAnnouncements_(['public', 'staff']).slice(0, 10), campStart: String(getSetting_('CampStart') || '2026-12-30') };
  });
}

function groupResults_() {
  const groups = {}, order = [];
  readResults_().filter(function(r) { return r.status === 'published'; }).forEach(function(r) {
    if (!groups[r.competition]) { groups[r.competition] = []; order.push(r.competition); }
    groups[r.competition].push({ team: r.team, place: r.place, points: r.points });
  });
  return order.map(function(c) {
    const rows = groups[c].sort(function(a, b) { return (a.place === null ? 999 : a.place) - (b.place === null ? 999 : b.place) || (b.points || 0) - (a.points || 0); });
    return { competition: c, rows: rows };
  });
}

// PUBLIC read-only feed for the display screens. Key lives in Script Properties (ADMIN_createFeedKey).
function handleFeed_(data) {
  const key = PropertiesService.getScriptProperties().getProperty('FEED_KEY');
  const given = String(data.key || '');
  let same = !!key && given.length === key.length;
  if (same) { let diff = 0; for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i); same = diff === 0; }
  if (!same) return { success: false, error: 'Invalid key' };
  return { success: true, serverTime: new Date().toISOString(), campStart: String(getSetting_('CampStart') || '2026-12-30'),
    announcements: publicAnnouncements_(['public']).slice(0, 30), results: groupResults_(),
    prayers: allPrayers_(), iqamaMinutes: iqamaMinutes_(), totals: teamTotals_(), displayTheme: displayTheme_(),
    program: readProgram_(), weather: (function() { try { return weatherCached_(); } catch (e) { return null; } })(),
    campName: String(getSetting_('CampName') || ''), campSlogan: String(getSetting_('CampSlogan') || ''), campDays: Number(getSetting_('CampDays')) || 4 };
}

// ---------------- Camp program (the committee attaches the Excel file; the big screen derives "now" and "next" from it) ----------------
// Tab "Program": one row per activity. Parallel activities (one per group) share the same Date + From. Text cells (no date conversion).
const PROGRAM_HEADERS_ = ['Date', 'From', 'To', 'Group', 'Title', 'Place', 'Type', 'Note'];
function hhmm_(min) { return min === null || min === undefined ? '' : (min < 600 ? '0' : '') + Math.floor(min / 60) + ':' + (min % 60 < 10 ? '0' : '') + (min % 60); }
function readProgram_() {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('program_v1'); if (hit) return JSON.parse(hit); } catch (e) { /* reread */ }
  let v; try { v = getSheetByName_('Program').getDataRange().getValues(); } catch (e) { return []; }
  const h = v[0] || [], out = [];
  for (let r = 1; r < v.length; r++) {
    const g = function(n) { const i = h.indexOf(n); return i === -1 ? '' : v[r][i]; };
    const d = parseStageDate_(g('Date')), from = parseStageTime_(g('From'));
    if (!d || from === null || !String(g('Title')).trim()) continue;
    const to = parseStageTime_(g('To'));
    out.push({ date: d.y + '-' + (d.m < 10 ? '0' : '') + d.m + '-' + (d.d < 10 ? '0' : '') + d.d, from: hhmm_(from), to: to === null ? '' : hhmm_(to),
      group: String(g('Group') || '').trim(), title: String(g('Title')).trim(), place: String(g('Place') || '').trim(), type: String(g('Type') || '').trim(), note: String(g('Note') || '').trim() });
  }
  out.sort(function(a, b) { return (a.date + a.from) < (b.date + b.from) ? -1 : (a.date + a.from) > (b.date + b.from) ? 1 : 0; });
  try { cache.put('program_v1', JSON.stringify(out), 300); } catch (e) { /* too large: read again next time */ }
  return out;
}
function handleProgramList_(data) {
  return withAuth_(data, requirePerm_('announce'), function() { return { success: true, program: readProgram_(), reviewed: programReviews_() }; });
}
// The committee marks each day "reviewed" after checking it. The mark never hides anything from the screen.
function programReviews_() {
  const out = {};
  readSheetAsObjects_(SETTINGS_SHEET).rows.forEach(function(r) {
    const k = String(r.Key || ''), v = String(r.Value || '');
    if (k.indexOf('ProgramReviewed_') === 0 && v) { const p = v.split('|'); out[k.slice(16)] = { by: p[0], at: p[1] || '' }; }
  });
  return out;
}
function handleProgramReview_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const date = String(data.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, error: 'اختر اليوم' };
    const on = data.reviewed !== false;
    setSetting_('ProgramReviewed_' + date, on ? user.Username + '|' + new Date().toISOString() : '');
    writeAudit_(user.Username, on ? 'PROGRAM_REVIEWED' : 'PROGRAM_UNREVIEWED', date, '');
    return { success: true };
  });
}
// The rows come from the Excel file read in the browser. All rows are checked first; nothing is written if one is wrong.
function handleProgramImport_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length || rows.length > 600) return { success: false, error: 'الملف لا يحوي برنامجًا صالحًا' };
    const clean = [], bad = [];
    rows.forEach(function(x, i) {
      const d = /^\d{4}-\d{2}-\d{2}$/.test(String(x.date || '')) ? String(x.date) : '', f = parseStageTime_(x.from), to = String(x.to || '').trim() ? parseStageTime_(x.to) : null;
      const title = String(x.title || '').trim().slice(0, 120);
      if (!d || f === null || !title || (String(x.to || '').trim() && to === null)) { bad.push(i + 1); return; }
      const txt = function(s, n) { return cellSafe_(String(s || '').trim().slice(0, n)); };
      clean.push(["'" + d, "'" + hhmm_(f), to === null ? '' : "'" + hhmm_(to), txt(x.group, 40), txt(title, 120), txt(x.place, 80), txt(x.type, 20), txt(x.note, 160)]);
    });
    if (bad.length) return { success: false, code: 'BAD_ROWS', error: 'أسطر غير صالحة: ' + bad.slice(0, 15).join('، '), rows: bad };
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      let sheet; try { sheet = getSheetByName_('Program'); } catch (e) { return { success: false, code: 'NEEDS_SETUP', error: 'شغّل SETUP_createTabs مرة واحدة' }; }
      const old = sheet.getDataRange().getValues(), w = PROGRAM_HEADERS_.length;
      if (old.length > 1) { // the previous program is kept in "ProgramArchive" (one write)
        try { const arc = getSheetByName_('ProgramArchive'), stamp = new Date(); const prev = old.slice(1).map(function(r) { const o = [stamp]; for (let c = 0; c < w; c++) o.push(r[c] === undefined ? '' : r[c]); return o; });
          arc.getRange(arc.getLastRow() + 1, 1, prev.length, w + 1).setValues(prev); } catch (e) { /* no archive tab: skip */ }
      }
      sheet.getRange(1, 1, 1, w).setValues([PROGRAM_HEADERS_]);
      sheet.getRange(2, 1, clean.length, w).setValues(clean);
      const extra = old.length - 1 - clean.length; // blank what is left of a longer old program
      if (extra > 0) { const blank = []; for (let i = 0; i < extra; i++) { const b = []; for (let c = 0; c < w; c++) b.push(''); blank.push(b); } sheet.getRange(2 + clean.length, 1, extra, w).setValues(blank); }
      try { CacheService.getScriptCache().remove('program_v1'); } catch (e) { /* ignore */ }
      writeAudit_(user.Username, 'PROGRAM_IMPORTED', '', 'rows=' + clean.length);
      return { success: true, rows: clean.length };
    } finally {
      lock.releaseLock();
    }
  });
}

// ---------------- Prayer times (typed by the committee, one row per day in Settings) ----------------
// Settings key "Prayer_YYYY-MM-DD" = "HH:MM|HH:MM|HH:MM|HH:MM|HH:MM" (Fajr|Dhuhr|Asr|Maghrib|Isha; empty = not shown).
// One competition at a time: the points of every team in one request. The places come from the points (ties share a place).
// replace: the earlier rows of the same competition are archived first (a correction). publish needs 'verify'.
function handleResSaveBatch_(data) {
  return withAuth_(data, requireAnyPerm_(['results', 'verify']), function(user) {
    const competition = String(data.competition || '').trim().slice(0, 60);
    if (competition.length < 2) return { success: false, error: 'اكتب اسم المسابقة' };
    const rows = [], seen = {};
    (Array.isArray(data.rows) ? data.rows : []).slice(0, 30).forEach(function(x) {
      const team = String(x && x.team || '').trim().slice(0, 40);
      if (!team || x.points === '' || x.points === null || x.points === undefined) return;
      const pts = Number(x.points);
      if (!isFinite(pts) || pts < 0 || pts > 100000) { rows.bad = true; return; }
      if (seen[team]) { rows.dup = true; return; }
      seen[team] = true; rows.push({ team: team, points: pts });
    });
    if (rows.bad) return { success: false, error: 'النقاط غير صالحة' };
    if (rows.dup) return { success: false, error: 'فريق مكرر' };
    if (!rows.length) return { success: false, error: 'أدخل نقاط فريق واحد على الأقل' };
    const publish = data.publish === true;
    if (publish && !hasPerm_(user, 'verify')) return { success: false, code: 'NEEDS_VERIFY', error: 'النشر يحتاج صلاحية التحقق من النتائج' };
    rows.sort(function(a, b) { return b.points - a.points; });
    rows.forEach(function(r, i) { r.place = i > 0 && rows[i - 1].points === r.points ? rows[i - 1].place : i + 1; });
    const clientId = String(data.clientId || '').slice(0, 60);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const all = readResults_(), sh = resultsSheet_();
      if (clientId && all.some(function(x) { return x.clientId === clientId + ':0'; })) return { success: true, repeated: true };
      let archived = 0;
      if (data.replace === true) all.forEach(function(x) { if (x.competition === competition && x.status !== 'archived') { setCell_(sh, x._row, 'Status', 'archived'); archived++; } });
      const now = new Date(), status = publish ? 'published' : 'draft';
      rows.forEach(function(r, i) { appendSafe_(sh, [newId_('R'), now, competition, r.team, r.place, r.points, status, user.Username, publish ? now : '', clientId ? clientId + ':' + i : '']); });
      writeAudit_(user.Username, publish ? 'RESULTS_PUBLISHED' : 'RESULTS_ENTERED', competition, 'n=' + rows.length + (archived ? ' replaced=' + archived : ''));
      return { success: true, saved: rows.length, archived: archived, published: publish };
    } finally {
      lock.releaseLock();
    }
  });
}

// ---------------- Teams (typed once by the media committee from the media page; used by the results entry) ----------------
function teamsList_() { return String(getSetting_('Teams') || '').split('|').map(function(x) { return x.trim(); }).filter(Boolean).slice(0, 30); }
function handleTeamsSave_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const list = [];
    (Array.isArray(data.teams) ? data.teams : []).forEach(function(x) { const t = String(x || '').replace(/[|]/g, ' ').trim().slice(0, 40); if (t && list.indexOf(t) === -1) list.push(t); });
    if (list.length > 30) return { success: false, error: 'الحد الأقصى 30 فريقًا' };
    setSetting_('Teams', list.join('|'));
    writeAudit_(user.Username, 'TEAMS_SAVED', '', 'n=' + list.length);
    return { success: true, teams: list };
  });
}

const PRAYER_NAMES_ = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
function allPrayers_() {
  const out = {};
  readSheetAsObjects_(SETTINGS_SHEET).rows.forEach(function(r) {
    const k = String(r.Key || '');
    if (k.indexOf('Prayer_') !== 0) return;
    const parts = String(r.Value || '').split('|'), day = {};
    PRAYER_NAMES_.forEach(function(n, i) { if (/^\d{2}:\d{2}$/.test(parts[i] || '')) day[n] = parts[i]; });
    out[k.slice(7)] = day;
  });
  return out;
}
function iqamaMinutes_() { const v = Number(getSetting_('IqamaMinutes')); return isFinite(v) && v > 0 && v <= 60 ? v : 15; }

function handlePrayerList_(data) {
  return withAuth_(data, requirePerm_('announce'), function() {
    return { success: true, prayers: allPrayers_(), iqamaMinutes: iqamaMinutes_(), displayTheme: displayTheme_() };
  });
}

function handlePrayerSave_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const date = String(data.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { success: false, error: 'اختر التاريخ' };
    const t = data.times || {};
    const vals = PRAYER_NAMES_.map(function(n) { const v = String(t[n] || '').trim(); return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : ''; });
    if (!vals.some(Boolean)) return { success: false, error: 'أدخل وقتاً واحداً على الأقل' };
    setSetting_('Prayer_' + date, vals.join('|'));
    if (data.iqamaMinutes !== undefined && data.iqamaMinutes !== '') {
      const m = Math.round(Number(data.iqamaMinutes));
      if (!isFinite(m) || m < 1 || m > 60) return { success: false, error: 'دقائق الإقامة بين 1 و 60' };
      setSetting_('IqamaMinutes', m);
    }
    writeAudit_(user.Username, 'PRAYER_SAVED', date, vals.join('|'));
    return { success: true };
  });
}

// The media committee can pin a theme on the display screen ('auto' = follows the time of day).
function displayTheme_() { const v = String(getSetting_('DisplayTheme') || 'auto'); return DISPLAY_THEMES_.indexOf(v) === -1 ? 'auto' : v; }
function handleDisplayTheme_(data) {
  return withAuth_(data, requirePerm_('announce'), function(user) {
    const v = String(data.theme || '');
    if (DISPLAY_THEMES_.indexOf(v) === -1) return { success: false, error: 'Invalid theme' };
    setSetting_('DisplayTheme', v);
    writeAudit_(user.Username, 'DISPLAY_THEME', '', v);
    return { success: true, theme: v };
  });
}

// Overall team ranking = sum of published points.
function teamTotals_() {
  const sum = {};
  readResults_().filter(function(r) { return r.status === 'published' && r.points !== null; }).forEach(function(r) { sum[r.team] = (sum[r.team] || 0) + r.points; });
  return Object.keys(sum).map(function(k) { return { team: k, points: sum[k] }; }).sort(function(a, b) { return b.points - a.points; });
}

// Run once from the Apps Script editor; copy the key from the log into the display-screen project. Run again to rotate.
function ADMIN_createFeedKey() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('FEED_KEY', key);
  Logger.log('FEED_KEY = ' + key);
  return key;
}
