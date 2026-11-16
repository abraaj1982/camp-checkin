// =============================================================
// Reports (secretariat). One action returns the rows of a report; the page filters columns, sorts, prints and exports.
// - Permission "reports" (admin has it too). Every run is written to the audit log.
// - NO phone numbers in any report. Nothing is written to the sheets here.
// =============================================================
const REPORTS_ = [
  { id: 'busAttendance', group: 'الحضور والباصات', title: 'كشف حضور الباص', filters: ['bus', 'team', 'cls', 'status'], landscape: false },
  { id: 'boardingSummary', group: 'الحضور والباصات', title: 'ملخص الصعود', filters: ['groupBy'], landscape: false },
  { id: 'exits', group: 'الخروج', title: 'استئذانات الخروج', filters: ['bus', 'exitStatus', 'from', 'to'], landscape: true },
  { id: 'shirtsStock', group: 'القمصان', title: 'القمصان: المسلَّم والمتبقي', filters: [], landscape: false },
  { id: 'shirtsPending', group: 'القمصان', title: 'القمصان: من لم يستلم', filters: ['kind', 'size'], landscape: false },
  { id: 'results', group: 'الفعاليات والنتائج', title: 'نتائج المسابقات', filters: [], landscape: false },
  { id: 'teamRanking', group: 'الفعاليات والنتائج', title: 'الترتيب العام للفرق', filters: [], landscape: false },
  { id: 'studentSheet', group: 'ملخصات', title: 'الكشف الموحّد للطلاب', filters: ['groups', 'bus', 'team', 'cls'], landscape: true },
  { id: 'campSummary', group: 'ملخصات', title: 'ملخص المخيم', filters: [], landscape: false }
];
const REPORT_MAX_ROWS_ = 2000;
const STATE_LABEL_ = { boarded: 'صعد', withdrawn: 'خرج بإذن', none: 'لم يصعد' };
const EXIT_LABEL_ = { open: 'معتمد (بانتظار الخروج)', closed: 'خرج', cancelled: 'مُلغى', reversed: 'أُعيد الطالب' };

function repText_(v, n) { return String(v === undefined || v === null ? '' : v).trim().slice(0, n || 40); }
function repUserName_(username) { const u = readUsersCached_().filter(function(r) { return r.Username === username; })[0]; return u && u.FullName ? u.FullName : String(username || ''); }
function repNum_(a, b) { const x = Number(a), y = Number(b); return (isFinite(x) && isFinite(y)) ? x - y : String(a).localeCompare(String(b), 'ar'); }

function handleReportOptions_(data) {
  return withAuth_(data, requirePerm_('reports'), function() {
    const st = readStudents_().students, uniq = function(k) { const m = {}; st.forEach(function(s) { if (s[k]) m[s[k]] = 1; }); return Object.keys(m).sort(repNum_); };
    return { success: true, reports: REPORTS_, buses: uniq('bus'), teams: uniq('team'), classes: uniq('cls'), sizes: Object.keys(readShirtStock_()).sort() };
  });
}

function handleReportData_(data) {
  return withAuth_(data, requirePerm_('reports'), function(user) {
    const def = REPORTS_.filter(function(r) { return r.id === String(data.report); })[0];
    if (!def) return { success: false, code: 'BAD_REQUEST', error: 'تقرير غير معروف' };
    const f = data.filters || {};
    const out = buildReport_(def, f);
    if (!out) return { success: false, code: 'BAD_REQUEST', error: 'تقرير غير معروف' };
    if (out.rows && out.rows.length > REPORT_MAX_ROWS_) out.rows = out.rows.slice(0, REPORT_MAX_ROWS_);
    out.success = true; out.report = def.id; out.title = def.title; out.group = def.group; out.landscape = def.landscape;
    out.generatedAt = new Date().toISOString(); out.generatedBy = user.FullName || user.Username;
    writeAudit_(user.Username, 'REPORT_RUN', def.id, JSON.stringify(f).slice(0, 150));
    return out;
  });
}

function buildReport_(def, f) {
  switch (def.id) {
    case 'busAttendance': return repBusAttendance_(f);
    case 'boardingSummary': return repBoardingSummary_(f);
    case 'exits': return repExits_(f);
    case 'shirtsStock': return repShirtsStock_();
    case 'shirtsPending': return repShirtsPending_(f);
    case 'results': return repResults_();
    case 'teamRanking': return repTeamRanking_();
    case 'studentSheet': return repStudentSheet_(f);
    case 'campSummary': return repCampSummary_();
  }
  return null;
}

function repBusAttendance_(f) {
  const bus = repText_(f.bus, 10), team = repText_(f.team), cls = repText_(f.cls, 10), status = ['boarded', 'missing', 'withdrawn'].indexOf(f.status) !== -1 ? f.status : '';
  const states = scanStates_().states;
  const rows = [];
  readStudents_().students.forEach(function(s) {
    if (bus && s.bus !== bus) return; if (team && s.team !== team) return; if (cls && s.cls !== cls) return;
    const st = states[s.id], state = st ? st.state : 'none';
    if (status === 'boarded' && state !== 'boarded') return; if (status === 'withdrawn' && state !== 'withdrawn') return; if (status === 'missing' && state !== 'none') return;
    rows.push({ id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus, state: STATE_LABEL_[state] || state, at: st && st.at && state !== 'none' ? st.at.toISOString() : '' });
  });
  rows.sort(function(a, b) { return repNum_(a.bus, b.bus) || repNum_(a.id, b.id); });
  return { kind: 'table', columns: [{ key: 'id', label: 'الرقم' }, { key: 'name', label: 'الاسم', wide: true }, { key: 'team', label: 'الفريق' }, { key: 'cls', label: 'الصف' }, { key: 'bus', label: 'الباص' }, { key: 'state', label: 'الحالة' }, { key: 'at', label: 'الوقت', type: 'time' }], rows: rows,
    filtersText: [bus && 'الباص ' + bus, team && 'الفريق ' + team, cls && 'الصف ' + cls, status && STATE_LABEL_[status === 'missing' ? 'none' : status]].filter(Boolean).join(' · ') };
}

function repBoardingSummary_(f) {
  const by = ['bus', 'team', 'cls'].indexOf(f.groupBy) !== -1 ? f.groupBy : 'bus', label = { bus: 'الباص', team: 'الفريق', cls: 'الصف' }[by];
  const states = scanStates_().states, g = {};
  readStudents_().students.forEach(function(s) {
    const k = s[by] || '—'; const r = g[k] = g[k] || { key: k, total: 0, boarded: 0, withdrawn: 0, missing: 0 };
    const st = states[s.id]; r.total++;
    if (st && st.state === 'boarded') r.boarded++; else if (st && st.state === 'withdrawn') r.withdrawn++; else r.missing++;
  });
  const rows = Object.keys(g).sort(repNum_).map(function(k) { const r = g[k]; r.pct = r.total ? Math.round(r.boarded / r.total * 100) : 0; return r; });
  const t = rows.reduce(function(a, r) { a.total += r.total; a.boarded += r.boarded; a.withdrawn += r.withdrawn; a.missing += r.missing; return a; }, { key: 'الإجمالي', total: 0, boarded: 0, withdrawn: 0, missing: 0 });
  t.pct = t.total ? Math.round(t.boarded / t.total * 100) : 0;
  return { kind: 'table', columns: [{ key: 'key', label: label }, { key: 'total', label: 'العدد', type: 'num' }, { key: 'boarded', label: 'صعدوا', type: 'num' }, { key: 'missing', label: 'لم يصعدوا', type: 'num' }, { key: 'withdrawn', label: 'خرجوا بإذن', type: 'num' }, { key: 'pct', label: 'نسبة الصعود %', type: 'num' }],
    rows: rows, totalRow: t, filtersText: 'حسب ' + label };
}

function repExits_(f) {
  const bus = repText_(f.bus, 10), status = ['open', 'closed', 'cancelled', 'reversed'].indexOf(f.exitStatus) !== -1 ? f.exitStatus : '';
  const from = /^\d{4}-\d{2}-\d{2}$/.test(f.from || '') ? f.from : '', to = /^\d{4}-\d{2}-\d{2}$/.test(f.to || '') ? f.to : '';
  const byId = {}; readStudents_().students.forEach(function(s) { byId[s.id] = s; });
  const rows = [];
  readWithdrawals_().forEach(function(w) {
    const s = byId[w.studentId] || { name: w.studentId, team: '', cls: '', bus: '' };
    const day = w.time.slice(0, 10);
    if (bus && s.bus !== bus) return; if (status && w.status !== status) return; if (from && day < from) return; if (to && day > to) return;
    rows.push({ id: w.studentId, name: s.name, team: s.team, bus: s.bus, guardian: w.guardian, reason: w.reason, status: EXIT_LABEL_[w.status] || w.status, approvedAt: w.time, approvedBy: repUserName_(w.by), exitedAt: w.status === 'closed' ? w.closedAt : '', exitedBy: w.status === 'closed' ? repUserName_(w.closedBy) : '' });
  });
  rows.sort(function(a, b) { return a.approvedAt < b.approvedAt ? -1 : 1; });
  return { kind: 'table', columns: [{ key: 'id', label: 'الرقم' }, { key: 'name', label: 'الاسم', wide: true }, { key: 'team', label: 'الفريق' }, { key: 'bus', label: 'الباص' }, { key: 'guardian', label: 'المستلِم' }, { key: 'reason', label: 'السبب', wide: true }, { key: 'status', label: 'الحالة' },
    { key: 'approvedAt', label: 'وقت الاعتماد', type: 'datetime' }, { key: 'approvedBy', label: 'اعتمده' }, { key: 'exitedAt', label: 'وقت الخروج', type: 'datetime' }, { key: 'exitedBy', label: 'أكّد الخروج' }], rows: rows, confidential: true,
    filtersText: [bus && 'الباص ' + bus, status && EXIT_LABEL_[status], from && 'من ' + from, to && 'إلى ' + to].filter(Boolean).join(' · ') };
}

function repShirtsStock_() {
  const people = shirtPeople_(), log = readShirtLog_(), t = shirtTable_(people, log, readShirtStock_());
  const lab = { ok: 'متوفر', low: 'يقارب النفاد', out: 'نفد', nostock: 'بلا مخزون' };
  const rows = t.map(function(r) { return { size: r.size, total: r.total, demand: r.demand, given: r.given, remaining: r.remaining, status: lab[r.status] || r.status }; });
  const sum = t.reduce(function(a, r) { a.total += r.total; a.demand += r.demand; a.given += r.given; a.remaining += r.remaining; return a; }, { size: 'الإجمالي', total: 0, demand: 0, given: 0, remaining: 0, status: '' });
  return { kind: 'table', columns: [{ key: 'size', label: 'المقاس' }, { key: 'total', label: 'المخزون', type: 'num' }, { key: 'demand', label: 'المطلوب (المسجَّل)', type: 'num' }, { key: 'given', label: 'سُلِّم', type: 'num' }, { key: 'remaining', label: 'المتبقي', type: 'num' }, { key: 'status', label: 'الحالة' }], rows: rows, totalRow: sum, filtersText: '' };
}

function repShirtsPending_(f) {
  const kind = ['student', 'staff'].indexOf(f.kind) !== -1 ? f.kind : '', size = normSize_(f.size);
  const given = activeGiven_(readShirtLog_()), rows = [];
  shirtPeople_().forEach(function(p) {
    if (given[p.kind + ':' + p.id]) return; if (kind && p.kind !== kind) return; if (size && p.size !== size) return;
    rows.push({ id: p.kind === 'staff' ? '' : p.id, name: p.name, kind: p.kind === 'staff' ? 'كادر' : 'طالب', team: p.team || '', bus: p.bus || '', size: p.size || 'غير محدد' });
  });
  rows.sort(function(a, b) { return String(a.size).localeCompare(String(b.size)) || String(a.name).localeCompare(String(b.name), 'ar'); });
  return { kind: 'table', columns: [{ key: 'id', label: 'الرقم' }, { key: 'name', label: 'الاسم', wide: true }, { key: 'kind', label: 'النوع' }, { key: 'team', label: 'الفريق' }, { key: 'bus', label: 'الباص' }, { key: 'size', label: 'المقاس' }], rows: rows,
    filtersText: [kind && (kind === 'staff' ? 'كادر' : 'طلاب'), size && 'المقاس ' + size].filter(Boolean).join(' · ') };
}

function repResults_() {
  const rows = [];
  groupResults_().forEach(function(g) { g.rows.forEach(function(r) { rows.push({ competition: g.competition, place: r.place === null ? '' : r.place, team: r.team, points: r.points === null ? '' : r.points }); }); });
  return { kind: 'table', columns: [{ key: 'competition', label: 'المسابقة', wide: true }, { key: 'place', label: 'المركز', type: 'num' }, { key: 'team', label: 'الفريق' }, { key: 'points', label: 'النقاط', type: 'num' }], rows: rows, filtersText: 'النتائج المنشورة فقط' };
}

function repTeamRanking_() {
  const rows = teamTotals_().map(function(r, i) { return { rank: i + 1, team: r.team, points: r.points }; });
  return { kind: 'table', columns: [{ key: 'rank', label: 'الترتيب', type: 'num' }, { key: 'team', label: 'الفريق' }, { key: 'points', label: 'مجموع النقاط', type: 'num' }], rows: rows, filtersText: 'النتائج المنشورة فقط' };
}

function repCampSummary_() {
  const students = readStudents_().students, states = scanStates_().states;
  let boarded = 0, withdrawn = 0;
  students.forEach(function(s) { const st = states[s.id]; if (st && st.state === 'boarded') boarded++; else if (st && st.state === 'withdrawn') withdrawn++; });
  const wd = readWithdrawals_(), med = readMedCases_(), people = shirtPeople_(), log = readShirtLog_(), given = activeGiven_(log);
  const sc = shirtSummary_(people, log);
  const staffSetting = getSetting_('StaffCount');
  const staff = (staffSetting !== null && String(staffSetting).trim() !== '' && isFinite(Number(staffSetting))) ? Math.round(Number(staffSetting)) : null;
  const bySum = repBoardingSummary_({ groupBy: 'bus' });
  const top = teamTotals_().slice(0, 4).map(function(r, i) { return { rank: i + 1, team: r.team, points: r.points }; });
  return { kind: 'summary', filtersText: '', sections: [
    { title: 'الحضور', kpis: [{ label: 'عدد الطلاب', value: students.length }, { label: 'صعدوا', value: boarded }, { label: 'لم يصعدوا', value: students.length - boarded - withdrawn }, { label: 'خرجوا بإذن', value: withdrawn }],
      table: { columns: bySum.columns, rows: bySum.rows, totalRow: bySum.totalRow } },
    { title: 'الخروج', kpis: [{ label: 'إجمالي الاستئذانات', value: wd.length }, { label: 'خرجوا فعلًا', value: wd.filter(function(w) { return w.status === 'closed'; }).length }, { label: 'بانتظار الخروج', value: wd.filter(function(w) { return w.status === 'open'; }).length }] },
    { title: 'الصحة (أعداد فقط)', kpis: [{ label: 'إجمالي الحالات', value: med.length }, { label: 'مفتوحة', value: med.filter(function(c) { return c.status === 'open'; }).length }, { label: 'مغلقة', value: med.filter(function(c) { return c.status === 'closed'; }).length }, { label: 'عاجلة', value: med.filter(function(c) { return c.severity === 'urgent'; }).length }] },
    { title: 'التغذية والقمصان', kpis: [{ label: 'حساسية غذائية مسجّلة', value: students.filter(function(s) { return s.foodAllergy; }).length }, { label: 'الكادر', value: staff === null ? '—' : staff }, { label: 'قمصان سُلِّمت (طلاب)', value: sc.studentsGiven + ' / ' + sc.students }, { label: 'قمصان سُلِّمت (كادر)', value: sc.staffGiven + ' / ' + sc.staff }] },
    { title: 'ترتيب الفرق', kpis: [], table: { columns: [{ key: 'rank', label: 'الترتيب', type: 'num' }, { key: 'team', label: 'الفريق' }, { key: 'points', label: 'النقاط', type: 'num' }], rows: top } }
  ] };
}

// One line per student, with the column groups the secretariat ticks (attendance, exits, shirts). No health data.
const SHEET_GROUPS_ = ['att', 'exit', 'shirt'];
function repStudentSheet_(f) {
  const groups = (Array.isArray(f.groups) ? f.groups : SHEET_GROUPS_).map(String).filter(function(g) { return SHEET_GROUPS_.indexOf(g) !== -1; });
  const use = groups.length ? groups : SHEET_GROUPS_;
  const bus = repText_(f.bus, 10), team = repText_(f.team), cls = repText_(f.cls, 10);
  const states = scanStates_().states;
  const lastExit = {}; readWithdrawals_().forEach(function(w) { if (w.status !== 'cancelled') lastExit[w.studentId] = w; });
  const given = activeGiven_(readShirtLog_());
  const rows = [];
  readStudents_().students.forEach(function(s) {
    if (bus && s.bus !== bus) return; if (team && s.team !== team) return; if (cls && s.cls !== cls) return;
    const r = { id: s.id, name: s.name, team: s.team, cls: s.cls, bus: s.bus };
    if (use.indexOf('att') !== -1) { const st = states[s.id], state = st ? st.state : 'none'; r.state = STATE_LABEL_[state] || state; r.at = st && st.at && state !== 'none' ? st.at.toISOString() : ''; }
    if (use.indexOf('exit') !== -1) { const w = lastExit[s.id]; r.exit = w ? (EXIT_LABEL_[w.status] || w.status) : ''; r.exitAt = w ? (w.status === 'closed' ? w.closedAt : w.time) : ''; }
    if (use.indexOf('shirt') !== -1) { const g = given['student:' + s.id]; r.size = normSize_(s.shirt) || 'غير محدد'; r.shirt = g ? 'استلم' : 'لم يستلم'; }
    rows.push(r);
  });
  rows.sort(function(a, b) { return repNum_(a.bus, b.bus) || repNum_(a.id, b.id); });
  const cols = [{ key: 'id', label: 'الرقم' }, { key: 'name', label: 'الاسم', wide: true }, { key: 'team', label: 'الفريق' }, { key: 'cls', label: 'الصف' }, { key: 'bus', label: 'الباص' }];
  if (use.indexOf('att') !== -1) cols.push({ key: 'state', label: 'الحالة' }, { key: 'at', label: 'الوقت', type: 'time' });
  if (use.indexOf('exit') !== -1) cols.push({ key: 'exit', label: 'الخروج' }, { key: 'exitAt', label: 'وقت الخروج', type: 'datetime' });
  if (use.indexOf('shirt') !== -1) cols.push({ key: 'size', label: 'المقاس' }, { key: 'shirt', label: 'القميص' });
  return { kind: 'table', columns: cols, rows: rows, filtersText: '' };
}
