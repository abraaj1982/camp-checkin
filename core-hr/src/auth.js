const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// السر يُقرأ من البيئة، وإلا يُولَّد مرة واحدة ويُحفظ محليًا (لا قيمة ثابتة في الكود)
function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(__dirname, '..', 'data', '.jwt_secret');
  try { return fs.readFileSync(f, 'utf8'); } catch {}
  const s = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

const sign = (emp) => jwt.sign({ id: emp.id, role: emp.role }, SECRET, { expiresIn: '12h' });

function requireAuth(db) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
    try {
      const p = jwt.verify(token, SECRET);
      const me = db.prepare('SELECT * FROM employees WHERE id = ?').get(p.id);
      if (!me || me.status !== 'active') return res.status(401).json({ error: 'الحساب غير نشط' });
      req.user = me;
      next();
    } catch {
      res.status(401).json({ error: 'جلسة منتهية' });
    }
  };
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'غير مصرّح' });

module.exports = { sign, requireAuth, requireRole };
