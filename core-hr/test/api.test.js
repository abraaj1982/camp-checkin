process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'AdminPass123';
const test = require('node:test');
const assert = require('node:assert');
require('../src/seed');
const { createApp } = require('../src/app');

let base, server;
test.before(async () => {
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

async function api(method, url, token, body) {
  const r = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const login = async (u, p) => (await api('POST', '/api/login', null, { username: u, password: p })).body?.token;

let admin, mgr, emp;
test('تسجيل الدخول وإنشاء الموظفين', async () => {
  assert.strictEqual((await api('POST', '/api/login', null, { username: 'admin', password: 'x' })).status, 401);
  admin = await login('admin', 'AdminPass123');
  assert.ok(admin);
  assert.strictEqual((await api('GET', '/api/employees')).status, 401);

  const m = await api('POST', '/api/employees', admin, { emp_no: '100', full_name: 'مدير', hire_date: '2024-01-01', username: 'mgr', password: 'Password123', role: 'manager' });
  assert.strictEqual(m.status, 201);
  const e = await api('POST', '/api/employees', admin, { emp_no: '101', full_name: 'موظف', hire_date: '2024-01-01', username: 'emp', password: 'Password123', manager_id: m.body.id });
  assert.strictEqual(e.status, 201);
  mgr = await login('mgr', 'Password123');
  emp = await login('emp', 'Password123');
});

test('الموظف لا يدير الموظفين ولا يرى الآخرين', async () => {
  assert.strictEqual((await api('POST', '/api/employees', emp, { emp_no: '9', full_name: 'x', hire_date: '2024-01-01' })).status, 403);
  const list = await api('GET', '/api/employees', emp);
  assert.strictEqual(list.body.length, 1);
  assert.strictEqual((await api('GET', '/api/audit', emp)).status, 403);
});

test('HR لا يستطيع تعيين مدير نظام', async () => {
  const hr = await api('POST', '/api/employees', admin, { emp_no: '102', full_name: 'موارد', hire_date: '2024-01-01', username: 'hr', password: 'Password123', role: 'hr' });
  assert.strictEqual(hr.status, 201);
  const t = await login('hr', 'Password123');
  const r = await api('POST', '/api/employees', t, { emp_no: '103', full_name: 'x', hire_date: '2024-01-01', role: 'admin' });
  assert.strictEqual(r.status, 403);
});

test('الإجازة: مدير ثم موارد بشرية', async () => {
  const hr = await login('hr', 'Password123');
  // الأحد 2030-03-03 إلى الخميس 2030-03-07 = 5 أيام عمل
  const r = await api('POST', '/api/leaves', emp, { leave_type_id: 1, start_date: '2030-03-03', end_date: '2030-03-07' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.days, 5);
  assert.strictEqual(r.body.status, 'pending_manager');
  // تداخل
  assert.strictEqual((await api('POST', '/api/leaves', emp, { leave_type_id: 1, start_date: '2030-03-05', end_date: '2030-03-06' })).status, 409);
  // الموظف لا يوافق على طلبه
  assert.strictEqual((await api('POST', `/api/leaves/${r.body.id}/decision`, emp, { approve: true })).status, 403);
  // HR لا يتخطى المدير
  assert.strictEqual((await api('POST', `/api/leaves/${r.body.id}/decision`, hr, { approve: true })).status, 403);
  const d1 = await api('POST', `/api/leaves/${r.body.id}/decision`, mgr, { approve: true });
  assert.strictEqual(d1.body.status, 'pending_hr');
  // المدير لا يوافق مرتين
  assert.strictEqual((await api('POST', `/api/leaves/${r.body.id}/decision`, mgr, { approve: true })).status, 403);
  const d2 = await api('POST', `/api/leaves/${r.body.id}/decision`, hr, { approve: true });
  assert.strictEqual(d2.body.status, 'approved');
  const bal = await api('GET', '/api/leaves/balances', emp);
  assert.ok(bal.status === 200);
});

test('رصيد غير كافٍ', async () => {
  const r = await api('POST', '/api/leaves', emp, { leave_type_id: 3, start_date: '2030-05-05', end_date: '2030-06-30' });
  assert.strictEqual(r.status, 400);
});

test('الحضور: نطاق الموقع', async () => {
  await api('POST', '/api/locations', admin, { name: 'المقر', lat: 23.588, lng: 58.3829, radius_m: 100 });
  assert.strictEqual((await api('POST', '/api/attendance/check-in', emp, { lat: 24.0, lng: 58.0 })).status, 403);
  assert.strictEqual((await api('POST', '/api/attendance/check-in', emp, {})).status, 403);
  const ok = await api('POST', '/api/attendance/check-in', emp, { lat: 23.5881, lng: 58.3829 });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual((await api('POST', '/api/attendance/check-in', emp, { lat: 23.5881, lng: 58.3829 })).status, 409);
  assert.strictEqual((await api('POST', '/api/attendance/check-out', emp, { lat: 23.5881, lng: 58.3829 })).status, 200);
  const dash = await api('GET', '/api/dashboard', admin);
  assert.strictEqual(dash.body.present_today, 1);
});
