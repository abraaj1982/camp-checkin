// =============================================================
// Media committee: announcements, events (countdown) and competition results.
// - Staff bulletin: every signed-in user sees published items (action 'bulletin').
// - Public feed for the separate display-screen project: action 'feed' with a READ-ONLY key.
//   The feed contains ONLY published public items. Never any student, medical or contact data.
// Workflow: announcements need 'announce'; results are entered with 'results' and published with 'verify'.
// =============================================================

const ANN_KINDS_ = ['announce', 'event', 'other'];
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
  sheet.getRange(rowNum, h.indexOf(colName) + 1).setValue(value);
}

function handleMediaList_(data) {
  return withAuth_(data, requireAnyPerm_(['announce', 'results', 'verify']), function() {
    const rank = { draft: 0, published: 1, archived: 2 };
    const sortFn = function(a, b) { return (rank[a.status] - rank[b.status]) || (a.createdAt < b.createdAt ? 1 : -1); };
    return { success: true, announcements: readAnnouncements_().sort(sortFn).slice(0, 100), results: readResults_().sort(sortFn).slice(0, 300),
      campStart: String(getSetting_('CampStart') || '2026-12-27') };
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
    if (kind === 'event') {
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
      annSheet_().appendRow([id, new Date(), title, body, kind, startsAt, audience, pinned, 'draft', user.Username, '', clientId]);
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
      resultsSheet_().appendRow([id, new Date(), competition, team, place, points, 'draft', user.Username, '', clientId]);
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
    return { success: true, items: publicAnnouncements_(['public', 'staff']).slice(0, 10), campStart: String(getSetting_('CampStart') || '2026-12-27') };
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
  return { success: true, serverTime: new Date().toISOString(), campStart: String(getSetting_('CampStart') || '2026-12-27'),
    announcements: publicAnnouncements_(['public']).slice(0, 30), results: groupResults_() };
}

// Run once from the Apps Script editor; copy the key from the log into the display-screen project. Run again to rotate.
function ADMIN_createFeedKey() {
  const key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('FEED_KEY', key);
  Logger.log('FEED_KEY = ' + key);
  return key;
}
