const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const { db, audit, setting } = require('./db');
const { sign, requireAuth, requireRole } = require('./auth');
const { distanceM, isDate, workingDays, omanNow } = require('./util');

const PUBLIC_FIELDS = `e.id, e.emp_no, e.full_name, e.national_id, e.phone, e.email, e.job_title,
  e.department_id, d.name AS department, e.manager_id, e.hire_date, e.status, e.username, e.role`;

const ROLES = ['admin', 'hr', 'manager', 'employee'];
const isHr = (u) => u.role === 'admin' || u.role === 'hr';
const fail = (res, code, error) => res.status(code).json({ error });
const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function teamIds(user) {
  return db.prepare('SELECT id FROM employees WHERE manager_id = ?').all(user.id).map((r) => r.id);
}
// هل يحق للمستخدم رؤية بيانات الموظف؟
function canSee(user, empId) {
  if (isHr(user) || user.id === empId) return true;
  return user.role === 'manager' && teamIds(user).includes(empId);
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const auth = requireAuth(db);

  // ---------- تسجيل الدخول (مع تحديد المحاولات) ----------
  const attempts = new Map();
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return fail(res, 400, 'بيانات ناقصة');
    const key = `${req.ip}|${username.toLowerCase()}`;
    const a = attempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) return fail(res, 429, 'محاولات كثيرة، حاول لاحقًا');
    const emp = db.prepare('SELECT * FROM employees WHERE username = ?').get(username);
    const ok = emp && emp.status === 'active' && emp.password_hash && bcrypt.compareSync(password, emp.password_hash);
    if (!ok) {
      a.n += 1;
      if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
      attempts.set(key, a);
      return fail(res, 401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    attempts.delete(key);
    audit(emp.id, 'login', 'employee', emp.id);
    res.json({ token: sign(emp), user: { id: emp.id, full_name: emp.full_name, role: emp.role } });
  });

  app.get('/api/me', auth, (req, res) => {
    const me = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM employees e LEFT JOIN departments d ON d.id = e.department_id WHERE e.id = ?`).get(req.user.id);
    res.json(me);
  });

  app.post('/api/me/password', auth, (req, res) => {
    const { current, next } = req.body || {};
    if (typeof next !== 'string' || next.length < 8) return fail(res, 400, 'كلمة المرور الجديدة 8 أحرف على الأقل');
    if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) return fail(res, 400, 'كلمة المرور الحالية غير صحيحة');
    db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id);
    audit(req.user.id, 'change_password', 'employee', req.user.id);
    res.json({ ok: true });
  });

  // ---------- بيانات مرجعية ----------
  app.get('/api/lookups', auth, (req, res) => {
    res.json({
      departments: db.prepare('SELECT * FROM departments ORDER BY name').all(),
      leave_types: db.prepare('SELECT * FROM leave_types ORDER BY id').all(),
      locations: db.prepare('SELECT * FROM work_locations').all(),
    });
  });

  app.post('/api/departments', auth, requireRole('admin', 'hr'), (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return fail(res, 400, 'الاسم مطلوب');
    try {
      const r = db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
      audit(req.user.id, 'create', 'department', r.lastInsertRowid, { name });
      res.status(201).json({ id: Number(r.lastInsertRowid), name });
    } catch { fail(res, 409, 'القسم موجود'); }
  });

  app.post('/api/locations', auth, requireRole('admin'), (req, res) => {
    const { name, lat, lng, radius_m } = req.body || {};
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return fail(res, 400, 'بيانات الموقع غير صحيحة');
    const r = db.prepare('INSERT INTO work_locations (name, lat, lng, radius_m) VALUES (?,?,?,?)')
      .run(name, lat, lng, Number.isInteger(radius_m) && radius_m > 0 ? radius_m : 150);
    audit(req.user.id, 'create', 'work_location', r.lastInsertRowid, { name });
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });

  // ---------- الموظفون ----------
  app.get('/api/employees', auth, (req, res) => {
    let rows;
    const base = `SELECT ${PUBLIC_FIELDS} FROM employees e LEFT JOIN departments d ON d.id = e.department_id`;
    if (isHr(req.user)) rows = db.prepare(`${base} ORDER BY e.emp_no`).all();
    else if (req.user.role === 'manager') rows = db.prepare(`${base} WHERE e.manager_id = ? OR e.id = ? ORDER BY e.emp_no`).all(req.user.id, req.user.id);
    else rows = db.prepare(`${base} WHERE e.id = ?`).all(req.user.id);
    res.json(rows);
  });

  app.post('/api/employees', auth, requireRole('admin', 'hr'), (req, res) => {
    const b = req.body || {};
    const role = b.role || 'employee';
    if (!b.emp_no || !b.full_name || !isDate(b.hire_date)) return fail(res, 400, 'الرقم الوظيفي والاسم وتاريخ التعيين مطلوبة');
    if (!ROLES.includes(role)) return fail(res, 400, 'دور غير صالح');
    if (role === 'admin' && req.user.role !== 'admin') return fail(res, 403, 'تعيين مدير النظام لمدير النظام فقط');
    if (b.username && (typeof b.password !== 'string' || b.password.length < 8)) return fail(res, 400, 'كلمة المرور 8 أحرف على الأقل');
    try {
      const r = db.prepare(`INSERT INTO employees
        (emp_no, full_name, national_id, phone, email, job_title, department_id, manager_id, hire_date, username, password_hash, role)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        b.emp_no, b.full_name, b.national_id ?? null, b.phone ?? null, b.email ?? null, b.job_title ?? null,
        b.department_id ?? null, b.manager_id ?? null, b.hire_date, b.username || null,
        b.username ? bcrypt.hashSync(b.password, 10) : null, role);
      const id = Number(r.lastInsertRowid);
      grantBalances(id, new Date().getUTCFullYear());
      audit(req.user.id, 'create', 'employee', id, { emp_no: b.emp_no, role });
      res.status(201).json({ id });
    } catch (e) {
      fail(res, 409, 'الرقم الوظيفي أو اسم المستخدم مستخدم مسبقًا أو مرجع غير صحيح');
    }
  });

  app.patch('/api/employees/:id', auth, requireRole('admin', 'hr'), (req, res) => {
    const id = Number(req.params.id);
    const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    if (!emp) return fail(res, 404, 'الموظف غير موجود');
    const b = req.body || {};
    if (b.role !== undefined) {
      if (!ROLES.includes(b.role)) return fail(res, 400, 'دور غير صالح');
      if ((b.role === 'admin' || emp.role === 'admin') && req.user.role !== 'admin') return fail(res, 403, 'تغيير دور مدير النظام لمدير النظام فقط');
    }
    const allowed = ['full_name', 'national_id', 'phone', 'email', 'job_title', 'department_id', 'manager_id', 'role'];
    const sets = allowed.filter((k) => b[k] !== undefined);
    if (b.manager_id === id) return fail(res, 400, 'لا يمكن أن يكون الموظف مديرًا لنفسه');
    if (!sets.length) return fail(res, 400, 'لا توجد حقول للتعديل');
    try {
      db.prepare(`UPDATE employees SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...sets.map((k) => b[k]), id);
    } catch { return fail(res, 400, 'قيمة غير صالحة'); }
    audit(req.user.id, 'update', 'employee', id, Object.fromEntries(sets.map((k) => [k, b[k]])));
    res.json({ ok: true });
  });

  app.post('/api/employees/:id/terminate', auth, requireRole('admin', 'hr'), (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) return fail(res, 400, 'لا يمكنك إنهاء خدمة حسابك');
    const r = db.prepare("UPDATE employees SET status = 'terminated' WHERE id = ? AND status = 'active'").run(id);
    if (!r.changes) return fail(res, 404, 'الموظف غير موجود أو خدمته منتهية');
    audit(req.user.id, 'terminate', 'employee', id, { note: req.body?.note });
    res.json({ ok: true });
  });

  function grantBalances(empId, year) {
    for (const t of db.prepare('SELECT * FROM leave_types').all())
      db.prepare('INSERT OR IGNORE INTO leave_balances (employee_id, leave_type_id, year, entitled) VALUES (?,?,?,?)').run(empId, t.id, year, t.annual_days);
  }

  // ---------- الحضور والانصراف ----------
  function checkGeofence(lat, lng) {
    const locs = db.prepare('SELECT * FROM work_locations').all();
    if (!locs.length) return { ok: true, distance: null };
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'تعذّر تحديد موقعك' };
    let best = Infinity, within = false;
    for (const l of locs) {
      const d = distanceM(lat, lng, l.lat, l.lng);
      best = Math.min(best, d);
      if (d <= l.radius_m) within = true;
    }
    return within ? { ok: true, distance: best } : { ok: false, error: `أنت خارج نطاق مقر العمل (${Math.round(best)} م)` };
  }

  app.post('/api/attendance/check-in', auth, (req, res) => {
    const { lat, lng } = req.body || {};
    const geo = checkGeofence(lat, lng);
    if (!geo.ok) return fail(res, 403, geo.error);
    const now = omanNow();
    if (db.prepare('SELECT 1 FROM attendance WHERE employee_id = ? AND work_date = ?').get(req.user.id, now.date))
      return fail(res, 409, 'سجّلت حضورك اليوم مسبقًا');
    const onLeave = db.prepare("SELECT 1 FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date").get(req.user.id, now.date);
    if (onLeave) return fail(res, 409, 'أنت في إجازة معتمدة اليوم');
    const late = Math.max(0, now.minutes - (mins(setting('work_start', '08:00')) + Number(setting('grace_minutes', '15'))));
    const r = db.prepare(`INSERT INTO attendance (employee_id, work_date, check_in, in_lat, in_lng, in_distance_m, late_minutes)
      VALUES (?,?,?,?,?,?,?)`).run(req.user.id, now.date, new Date().toISOString(), lat ?? null, lng ?? null, geo.distance, late);
    audit(req.user.id, 'check_in', 'attendance', r.lastInsertRowid);
    res.status(201).json({ work_date: now.date, late_minutes: late });
  });

  app.post('/api/attendance/check-out', auth, (req, res) => {
    const { lat, lng } = req.body || {};
    const geo = checkGeofence(lat, lng);
    if (!geo.ok) return fail(res, 403, geo.error);
    const now = omanNow();
    const rec = db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(req.user.id, now.date);
    if (!rec) return fail(res, 409, 'لم تسجّل حضورًا اليوم');
    if (rec.check_out) return fail(res, 409, 'سجّلت انصرافك مسبقًا');
    db.prepare('UPDATE attendance SET check_out = ?, out_lat = ?, out_lng = ?, out_distance_m = ? WHERE id = ?')
      .run(new Date().toISOString(), lat ?? null, lng ?? null, geo.distance, rec.id);
    audit(req.user.id, 'check_out', 'attendance', rec.id);
    res.json({ ok: true });
  });

  app.get('/api/attendance/today', auth, (req, res) => {
    const now = omanNow();
    res.json(db.prepare('SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?').get(req.user.id, now.date) || null);
  });

  app.get('/api/attendance', auth, (req, res) => {
    const from = isDate(req.query.from) ? req.query.from : omanNow().date.slice(0, 8) + '01';
    const to = isDate(req.query.to) ? req.query.to : omanNow().date;
    let empId = req.query.employee_id ? Number(req.query.employee_id) : null;
    if (empId && !canSee(req.user, empId)) return fail(res, 403, 'غير مصرّح');
    const q = `SELECT a.*, e.full_name, e.emp_no FROM attendance a JOIN employees e ON e.id = a.employee_id
               WHERE a.work_date BETWEEN ? AND ?`;
    let rows;
    if (empId) rows = db.prepare(`${q} AND a.employee_id = ? ORDER BY a.work_date DESC`).all(from, to, empId);
    else if (isHr(req.user)) rows = db.prepare(`${q} ORDER BY a.work_date DESC, e.emp_no`).all(from, to);
    else if (req.user.role === 'manager') rows = db.prepare(`${q} AND (e.manager_id = ? OR e.id = ?) ORDER BY a.work_date DESC`).all(from, to, req.user.id, req.user.id);
    else rows = db.prepare(`${q} AND a.employee_id = ? ORDER BY a.work_date DESC`).all(from, to, req.user.id);
    res.json(rows);
  });

  // ---------- الإجازات ----------
  const usedDays = (empId, typeId, year, statuses) => db.prepare(
    `SELECT COALESCE(SUM(days),0) AS n FROM leave_requests WHERE employee_id = ? AND leave_type_id = ?
     AND status IN (${statuses.map(() => '?').join(',')}) AND substr(start_date,1,4) = ?`).get(empId, typeId, ...statuses, String(year)).n;

  function balancesFor(empId, year) {
    return db.prepare(`SELECT lt.id AS leave_type_id, lt.name, lb.entitled FROM leave_balances lb
      JOIN leave_types lt ON lt.id = lb.leave_type_id WHERE lb.employee_id = ? AND lb.year = ?`).all(empId, year).map((b) => {
      const used = usedDays(empId, b.leave_type_id, year, ['approved']);
      const pending = usedDays(empId, b.leave_type_id, year, ['pending_manager', 'pending_hr']);
      return { ...b, used, pending, remaining: b.entitled - used - pending };
    });
  }

  app.get('/api/leaves/balances', auth, (req, res) => {
    const empId = req.query.employee_id ? Number(req.query.employee_id) : req.user.id;
    if (!canSee(req.user, empId)) return fail(res, 403, 'غير مصرّح');
    res.json(balancesFor(empId, new Date().getUTCFullYear()));
  });

  app.post('/api/leaves', auth, (req, res) => {
    const { leave_type_id, start_date, end_date, reason } = req.body || {};
    if (!isDate(start_date) || !isDate(end_date) || end_date < start_date) return fail(res, 400, 'تواريخ غير صحيحة');
    if (start_date.slice(0, 4) !== end_date.slice(0, 4)) return fail(res, 400, 'قدّم طلبين منفصلين لإجازة تمتد بين سنتين');
    const type = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(leave_type_id);
    if (!type) return fail(res, 400, 'نوع الإجازة غير صحيح');
    const holidays = JSON.parse(setting('holidays', '[]'));
    const days = workingDays(start_date, end_date, JSON.parse(setting('weekend', '[5,6]')), holidays);
    if (days === 0) return fail(res, 400, 'الفترة لا تتضمن أيام عمل');
    const year = Number(start_date.slice(0, 4));
    grantBalances(req.user.id, year);
    const bal = balancesFor(req.user.id, year).find((b) => b.leave_type_id === type.id);
    if (!bal || days > bal.remaining) return fail(res, 400, `الرصيد غير كافٍ (المتبقي ${bal ? bal.remaining : 0} يوم)`);
    const overlap = db.prepare(`SELECT 1 FROM leave_requests WHERE employee_id = ? AND status IN ('pending_manager','pending_hr','approved')
      AND start_date <= ? AND end_date >= ?`).get(req.user.id, end_date, start_date);
    if (overlap) return fail(res, 409, 'يوجد طلب إجازة متداخل');
    const status = req.user.manager_id ? 'pending_manager' : 'pending_hr';
    const r = db.prepare(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
      VALUES (?,?,?,?,?,?,?)`).run(req.user.id, type.id, start_date, end_date, days, reason ?? null, status);
    audit(req.user.id, 'create', 'leave_request', r.lastInsertRowid, { days, status });
    res.status(201).json({ id: Number(r.lastInsertRowid), days, status });
  });

  app.get('/api/leaves', auth, (req, res) => {
    const base = `SELECT r.*, e.full_name, e.emp_no, lt.name AS leave_type FROM leave_requests r
      JOIN employees e ON e.id = r.employee_id JOIN leave_types lt ON lt.id = r.leave_type_id`;
    const scope = req.query.scope;
    let rows;
    if (scope === 'inbox') {
      // الطلبات بانتظار قراري
      if (isHr(req.user)) rows = db.prepare(`${base} WHERE r.status = 'pending_hr' AND r.employee_id != ? ORDER BY r.created_at`).all(req.user.id);
      else if (req.user.role === 'manager') rows = db.prepare(`${base} WHERE r.status = 'pending_manager' AND e.manager_id = ? ORDER BY r.created_at`).all(req.user.id);
      else rows = [];
      if (isHr(req.user) && scope === 'inbox') {
        // المدير المباشر قد يكون من الموارد البشرية أيضًا
        rows = rows.concat(db.prepare(`${base} WHERE r.status = 'pending_manager' AND e.manager_id = ? ORDER BY r.created_at`).all(req.user.id));
      }
    } else if (scope === 'all' && isHr(req.user)) rows = db.prepare(`${base} ORDER BY r.created_at DESC`).all();
    else rows = db.prepare(`${base} WHERE r.employee_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
    res.json(rows);
  });

  app.post('/api/leaves/:id/decision', auth, (req, res) => {
    const id = Number(req.params.id);
    const { approve, note } = req.body || {};
    if (typeof approve !== 'boolean') return fail(res, 400, 'القرار مطلوب');
    const r = db.prepare('SELECT r.*, e.manager_id FROM leave_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = ?').get(id);
    if (!r) return fail(res, 404, 'الطلب غير موجود');
    if (r.employee_id === req.user.id) return fail(res, 403, 'لا يمكنك البتّ في طلبك');

    if (r.status === 'pending_manager') {
      if (r.manager_id !== req.user.id) return fail(res, 403, 'هذه الموافقة للمدير المباشر');
      db.prepare('UPDATE leave_requests SET status = ?, manager_decision_by = ?, decision_note = ? WHERE id = ?')
        .run(approve ? 'pending_hr' : 'rejected', req.user.id, note ?? null, id);
    } else if (r.status === 'pending_hr') {
      if (!isHr(req.user)) return fail(res, 403, 'هذه الموافقة للموارد البشرية');
      db.prepare('UPDATE leave_requests SET status = ?, hr_decision_by = ?, decision_note = ? WHERE id = ?')
        .run(approve ? 'approved' : 'rejected', req.user.id, note ?? null, id);
    } else return fail(res, 409, 'الطلب مغلق');
    audit(req.user.id, approve ? 'approve' : 'reject', 'leave_request', id, { note });
    res.json({ ok: true, status: db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(id).status });
  });

  app.post('/api/leaves/:id/cancel', auth, (req, res) => {
    const r = db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ? AND employee_id = ? AND status IN ('pending_manager','pending_hr')")
      .run(Number(req.params.id), req.user.id);
    if (!r.changes) return fail(res, 409, 'لا يمكن إلغاء هذا الطلب');
    audit(req.user.id, 'cancel', 'leave_request', Number(req.params.id));
    res.json({ ok: true });
  });

  // ---------- لوحة التحكم والتدقيق ----------
  app.get('/api/dashboard', auth, requireRole('admin', 'hr', 'manager'), (req, res) => {
    const today = omanNow().date;
    const ids = isHr(req.user) ? db.prepare("SELECT id FROM employees WHERE status = 'active'").all().map((r) => r.id)
      : teamIds(req.user);
    const inList = ids.length ? ids.join(',') : 'NULL';
    const count = (sql, ...p) => db.prepare(sql).get(...p).n;
    res.json({
      total_employees: ids.length,
      present_today: count(`SELECT COUNT(*) n FROM attendance WHERE work_date = ? AND employee_id IN (${inList})`, today),
      late_today: count(`SELECT COUNT(*) n FROM attendance WHERE work_date = ? AND late_minutes > 0 AND employee_id IN (${inList})`, today),
      on_leave_today: count(`SELECT COUNT(DISTINCT employee_id) n FROM leave_requests WHERE status = 'approved' AND ? BETWEEN start_date AND end_date AND employee_id IN (${inList})`, today),
      pending_leaves: count(`SELECT COUNT(*) n FROM leave_requests WHERE status IN ('pending_manager','pending_hr') AND employee_id IN (${inList})`),
    });
  });

  app.get('/api/audit', auth, requireRole('admin', 'hr'), (req, res) => {
    res.json(db.prepare(`SELECT a.*, e.full_name AS actor FROM audit_log a LEFT JOIN employees e ON e.id = a.actor_id
      ORDER BY a.id DESC LIMIT 200`).all());
  });

  app.use('/api', (req, res) => fail(res, 404, 'غير موجود'));
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'JSON غير صالح');
    console.error(err);
    fail(res, 500, 'خطأ في الخادم');
  });
  return app;
}

module.exports = { createApp };
