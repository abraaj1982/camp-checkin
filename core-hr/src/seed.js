// يهيّئ الإعدادات وأنواع الإجازات وحساب مدير النظام الأول.
// كلمة مرور المدير من ADMIN_PASSWORD أو تُولَّد عشوائيًا وتُطبع مرة واحدة.
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const { db } = require('./db');

const settings = { work_start: '08:00', grace_minutes: '15', weekend: '[5,6]', holidays: '[]' };
for (const [k, v] of Object.entries(settings))
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)').run(k, v);

// القيم الافتراضية للمراجعة مع المستشار القانوني قبل الاعتماد
for (const [name, days] of [['إجازة سنوية', 30], ['إجازة مرضية', 10], ['إجازة طارئة', 6]])
  db.prepare('INSERT OR IGNORE INTO leave_types (name, annual_days) VALUES (?,?)').run(name, days);

if (!db.prepare("SELECT 1 FROM employees WHERE role = 'admin'").get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare(`INSERT INTO employees (emp_no, full_name, hire_date, username, password_hash, role)
    VALUES ('0001', 'مدير النظام', date('now'), 'admin', ?, 'admin')`).run(bcrypt.hashSync(pw, 10));
  console.log(`تم إنشاء المدير: admin / ${process.env.ADMIN_PASSWORD ? '(من ADMIN_PASSWORD)' : pw}`);
} else console.log('مدير النظام موجود مسبقًا');
