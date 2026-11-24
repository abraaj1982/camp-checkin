// ============================================================
// MUKHAYYAM — Auth Layer (PRODUCTION) — Phase 1
// ============================================================

const USERS_SHEET = 'Users';
const SETTINGS_SHEET = 'Settings';
const AUDIT_SHEET = 'AuditLog';

// Sessions: one login per camp day (12 h). Accounts that open sensitive data (users, medical, custody/exits) are signed out
// after 30 min without use; everyone else after 2 h, so volunteers are not logged out in the middle of a shift.
const TOKEN_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;          // sensitive accounts
const IDLE_TIMEOUT_OPERATIONAL_MS = 2 * 60 * 60 * 1000;
const SENSITIVE_PERMS_ = ['manage', 'support', 'medical', 'custody'];
function idleLimitFor_(user) {
  const sensitive = SENSITIVE_PERMS_.some(function(k) { return hasPerm_(user, k); }) || getUserPermissions_(user).indexOf('*') !== -1;
  return sensitive ? IDLE_TIMEOUT_MS : IDLE_TIMEOUT_OPERATIONAL_MS;
}
const ACTIVITY_WRITE_DEBOUNCE_MS = 5 * 60 * 1000;
const PBKDF2_ITERATIONS = 1000; // used for NEW passwords only — see hashPassword_/verifyPassword_
const LEGACY_PBKDF2_ITERATIONS = 20000; // iteration count used before this field was stored per-password
const HASH_OUTPUT_BYTES = 32;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

// ---------------- Permissions model (Week 1) ----------------
// A user's effective permissions = the comma-separated keys in Users.Permissions.
// If that cell is empty, we fall back to the defaults of the legacy Role.
// Role "admin" always has everything ('*') so the owner can never be locked out.
const ROLE_DEFAULTS_ = {
  supervisor: ['checkin'],
  camp_leader: ['dashboard'],
  finance: ['finance', 'approve', 'budget'],
  shirts_coordinator: ['shirts']
};

function splitCsv_(value) {
  return String(value === null || value === undefined ? '' : value)
    .split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
}

function getUserPermissions_(user) {
  if (user.Role === 'admin') return ['*'];
  const explicit = splitCsv_(user.Permissions);
  if (explicit.length > 0) return explicit;
  return (ROLE_DEFAULTS_[user.Role] || []).slice();
}

function hasPerm_(user, key) {
  const perms = getUserPermissions_(user);
  return perms.indexOf('*') !== -1 || perms.indexOf(key) !== -1;
}

function requirePerm_(key) {
  return function(user) { return hasPerm_(user, key); };
}

function requireAnyPerm_(keys) {
  return function(user) { return keys.some(function(k) { return hasPerm_(user, k); }); };
}

// Speed: opening the spreadsheet costs ~0.3 s and a request touches 5-10 tabs, so open it ONCE per request and reuse the tab handles.
let SS_MEMO_ = null;
const SHEET_MEMO_ = {};
function getSheetByName_(name) {
  if (SHEET_MEMO_[name]) return SHEET_MEMO_[name];
  if (!SS_MEMO_) SS_MEMO_ = SpreadsheetApp.openById(SHEET_ID);
  const sheet = SS_MEMO_.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  SHEET_MEMO_[name] = sheet;
  return sheet;
}

function readSheetAsObjects_(sheetName) {
  const sheet = getSheetByName_(sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return { headers: [], rows: [], sheet: sheet };
  const headers = data[0];
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = data[i][c];
    obj._rowNumber = i + 1;
    rows.push(obj);
  }
  return { headers: headers, rows: rows, sheet: sheet };
}

// Users table cached for 60 s (every request needs it for authorization). Every write we make to Users clears the cache,
// so changes made from the app apply at once; a manual edit in the sheet applies within a minute.
function readUsersCached_() {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('users_v1'); if (hit) return JSON.parse(hit); } catch (e) { /* fall through */ }
  const startedAt = Date.now();
  const rows = readSheetAsObjects_(USERS_SHEET).rows;
  try {
    // If the Users tab was written while we were reading (password reset, disable, ...), our copy may be stale and must
    // not stay cached (a revoked session could keep working for a minute). Cache it, THEN check: clearUsersCache_ stamps
    // the time before removing, so whichever order the two run in, a stale copy is always removed.
    cache.put('users_v1', JSON.stringify(rows), 60);
    if ((Number(cache.get('users_cleared_at')) || 0) >= startedAt) cache.remove('users_v1');
  } catch (e) { /* too large: skip */ }
  return rows;
}
function clearUsersCache_() {
  try { const cache = CacheService.getScriptCache(); cache.put('users_cleared_at', String(Date.now()), 600); cache.remove('users_v1'); } catch (e) { /* ignore */ }
}

function colIndexByName_(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error('Column not found: ' + name);
  return idx + 1;
}

// Formula-injection guard: text typed by users must never become a Sheets formula.
// A leading apostrophe makes Sheets store the value as plain text (it is not part of the value read back).
function cellSafe_(v) { return (typeof v === 'string' && /^[=+\-@\t\r]/.test(v)) ? "'" + v : v; }
function appendSafe_(sheet, row) { sheet.appendRow(row.map(cellSafe_)); }

function setCellByColumnName_(sheet, headers, rowNumber, columnName, value) {
  if (headers.indexOf('PasswordHash') !== -1) clearUsersCache_(); // a write to the Users tab
  sheet.getRange(rowNumber, colIndexByName_(headers, columnName)).setValue(cellSafe_(value));
}

// Settings rarely change: cache them for 2 minutes (setSetting_ clears the cache).
function getSetting_(key) {
  const cache = CacheService.getScriptCache();
  let all = null;
  try { const hit = cache.get('settings_v1'); if (hit) all = JSON.parse(hit); } catch (e) { all = null; }
  if (!all) {
    all = {};
    readSheetAsObjects_(SETTINGS_SHEET).rows.forEach(function(r) { if (r.Key) all[r.Key] = r.Value === undefined ? '' : r.Value; });
    try { cache.put('settings_v1', JSON.stringify(all), 120); } catch (e) { /* ignore */ }
  }
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : null;
}

function setSetting_(key, value) {
  try { CacheService.getScriptCache().remove('settings_v1'); } catch (e) { /* ignore */ }
  const { rows, headers, sheet } = readSheetAsObjects_(SETTINGS_SHEET);
  const existing = rows.find(r => r.Key === key);
  if (existing) {
    setCellByColumnName_(sheet, headers, existing._rowNumber, 'Value', value);
  } else {
    appendSafe_(sheet, [key, value]);
  }
}

function bytesToHex_(bytes) {
  return bytes.map(b => (('0' + ((b & 0xff).toString(16))).slice(-2))).join('');
}

function randomBytes_(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.floor(Math.random() * 256));
  return out;
}

function base64urlEncode_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function base64urlEncodeString_(str) {
  return base64urlEncode_(Utilities.newBlob(str).getBytes());
}

function base64urlDecodeToString_(b64) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(b64)).getDataAsString();
}

function constantTimeEquals_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function pbkdf2_(password, saltBytes, iterations, outputBytes) {
  const passwordBytes = Utilities.newBlob(password).getBytes().map(b => b & 0xff);
  const hLen = 32;
  const blocksNeeded = Math.ceil(outputBytes / hLen);
  let derived = [];

  for (let blockIndex = 1; blockIndex <= blocksNeeded; blockIndex++) {
    const intBlock = [
      (blockIndex >> 24) & 0xff,
      (blockIndex >> 16) & 0xff,
      (blockIndex >> 8) & 0xff,
      blockIndex & 0xff
    ];
    let u = Utilities.computeHmacSha256Signature(saltBytes.concat(intBlock), passwordBytes)
      .map(b => b & 0xff);
    let t = u.slice();
    for (let iter = 1; iter < iterations; iter++) {
      u = Utilities.computeHmacSha256Signature(u, passwordBytes).map(b => b & 0xff);
      for (let k = 0; k < t.length; k++) t[k] = t[k] ^ u[k];
    }
    derived = derived.concat(t);
  }
  return derived.slice(0, outputBytes);
}

function hashPassword_(password) {
  const salt = randomBytes_(16);
  const hash = pbkdf2_(password, salt, PBKDF2_ITERATIONS, HASH_OUTPUT_BYTES);
  return {
    saltB64: Utilities.base64Encode(salt),
    hashHex: PBKDF2_ITERATIONS + '$' + bytesToHex_(hash)
  };
}

function verifyPassword_(password, saltB64, storedHashField) {
  let iterations, expectedHashHex;
  const field = String(storedHashField || '');
  if (field.indexOf('$') === -1) {
    iterations = LEGACY_PBKDF2_ITERATIONS;
    expectedHashHex = field;
  } else {
    const parts = field.split('$');
    iterations = Number(parts[0]);
    expectedHashHex = parts[1];
  }
  const salt = Utilities.base64Decode(saltB64).map(b => b & 0xff);
  const computed = bytesToHex_(pbkdf2_(password, salt, iterations, HASH_OUTPUT_BYTES));
  return constantTimeEquals_(computed, expectedHashHex);
}

function getTokenSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    const seed = Utilities.getUuid() + Utilities.getUuid() + new Date().getTime() + Math.random();
    secret = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed));
    props.setProperty('TOKEN_SECRET', secret);
  }
  return secret;
}

function signToken_(payloadObj) {
  const header = { alg: 'HS256', typ: 'MUKHAYYAM-AUTH' };
  const headerB64 = base64urlEncodeString_(JSON.stringify(header));
  const payloadB64 = base64urlEncodeString_(JSON.stringify(payloadObj));
  const signingInput = headerB64 + '.' + payloadB64;
  const sigBytes = Utilities.computeHmacSha256Signature(signingInput, getTokenSecret_());
  const sigB64 = base64urlEncode_(sigBytes);
  return signingInput + '.' + sigB64;
}

function verifyTokenSignatureAndDecode_(token) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const signingInput = parts[0] + '.' + parts[1];
  const expectedSigBytes = Utilities.computeHmacSha256Signature(signingInput, getTokenSecret_());
  const expectedSigB64 = base64urlEncode_(expectedSigBytes);
  if (!constantTimeEquals_(expectedSigB64, parts[2])) return { ok: false, reason: 'BAD_SIGNATURE' };

  let payload;
  try {
    payload = JSON.parse(base64urlDecodeToString_(parts[1]));
  } catch (e) {
    return { ok: false, reason: 'BAD_PAYLOAD' };
  }
  return { ok: true, payload: payload };
}

function usersSheetHasAnyUser_() {
  const { rows } = readSheetAsObjects_(USERS_SHEET);
  return rows.length > 0;
}

function getBootstrapSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('BOOTSTRAP_SECRET');
  if (!secret) {
    const seed = Utilities.getUuid() + new Date().getTime() + Math.random();
    secret = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed));
    props.setProperty('BOOTSTRAP_SECRET', secret);
    props.setProperty('BOOTSTRAP_USED', 'false');
  }
  return secret;
}

function ADMIN_printBootstrapSecret() {
  Logger.log('Bootstrap secret: ' + getBootstrapSecret_());
}

function writeAudit_(actor, action, target, details) {
  const sheet = getSheetByName_(AUDIT_SHEET);
  appendSafe_(sheet, [new Date(), actor, action, target || '', details || '']);
}

// Usernames are NOT case-sensitive ("Admin_test" = "admin_test"): phones capitalise the first letter automatically.
function sameUsername_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }
function findUserRow_(username) {
  const { rows } = readSheetAsObjects_(USERS_SHEET);
  return rows.find(r => sameUsername_(r.Username, username));
}

// Writes FailedAttempts, LockedUntil, TokenEpoch, LastActivityAt, CreatedAt, LastLogin (H:M) in ONE call (every Sheets call costs ~1 s).
// TokenEpoch is written back with the value of the FRESH row that login read under the lock; every other writer of TokenEpoch
// (revoke, password reset) also holds that lock, so it cannot be undone. If the columns are not next to each other, two calls as before.
function writeLoginSuccessRow_(sheet, headers, user, now) {
  const n = ['FailedAttempts', 'LockedUntil', 'TokenEpoch', 'LastActivityAt', 'CreatedAt', 'LastLogin'].map(function(k) { return colIndexByName_(headers, k); });
  const together = n.every(function(c, i) { return i === 0 || c === n[i - 1] + 1; });
  if (together) { sheet.getRange(user._rowNumber, n[0], 1, 6).setValues([[0, '', user.TokenEpoch === undefined ? '' : user.TokenEpoch, now, user.CreatedAt, now]]); return; }
  sheet.getRange(user._rowNumber, n[0], 1, 2).setValues([[0, '']]);
  sheet.getRange(user._rowNumber, n[3], 1, 3).setValues([[now, user.CreatedAt, now]]);
}

function handleLogin_(data) {
  // Speed: the first look-up (is there such a user, his salt and hash) uses the 60-second Users cache instead of reading the whole tab
  // (about 1-1.5 s saved when the cache is warm). Everything that decides the login is checked again on a FRESH row under the lock below.
  const rows = readUsersCached_();
  const user = rows.find(r => sameUsername_(r.Username, data.username));
  if (!user) return { success: false, error: 'Invalid username or password' };

  const now = new Date();
  if (user.LockedUntil && new Date(user.LockedUntil) > now) {
    return { success: false, error: 'Account temporarily locked. Try again later.' };
  }
  if (user.Active !== true) {
    return { success: false, error: 'Account disabled' };
  }

  const passwordOk = verifyPassword_(data.password, user.Salt, user.PasswordHash);
  // Old accounts store a slow legacy hash (login takes ~9 s): it is upgraded silently on the first good login.
  const upgrade = passwordOk && String(user.PasswordHash || '').indexOf('$') === -1 ? hashPassword_(data.password) : null; // slow work: outside the lock

  // The security decision (count a failure / lock the account / accept the login) is taken under the lock, on a FRESH row:
  // simultaneous wrong guesses are all counted, and a login finishing at the same moment cannot erase a lock they caused.
  // If the lock is busy the request fails with the same generic error whether the password was right or wrong.
  let failed = false, lockedNow = false, epoch = 0;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const fresh = readSheetAsObjects_(USERS_SHEET);
    const cur = fresh.rows.find(r => r.Username === user.Username);
    if (!cur) return { success: false, error: 'Invalid username or password' };
    if (cur.LockedUntil && new Date(cur.LockedUntil) > now) return { success: false, error: 'Account temporarily locked. Try again later.' }; // same answer for right and wrong guesses
    if (cur.Active !== true) return { success: false, error: 'Account disabled' };
    if (!passwordOk || String(cur.PasswordHash) !== String(user.PasswordHash)) { // wrong (or the password was changed meanwhile)
      const attempts = (Number(cur.FailedAttempts) || 0) + 1;
      setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'FailedAttempts', attempts);
      if (attempts >= MAX_FAILED_ATTEMPTS) {
        setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'LockedUntil', new Date(now.getTime() + LOCKOUT_MS));
        lockedNow = attempts === MAX_FAILED_ATTEMPTS;
      }
      failed = true;
    } else {
      if (upgrade) {
        setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'PasswordHash', upgrade.hashHex);
        setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'Salt', upgrade.saltB64);
      }
      writeLoginSuccessRow_(fresh.sheet, fresh.headers, cur, now);
      epoch = Number(cur.TokenEpoch) || 0;
    }
  } finally {
    lock.releaseLock();
  }
  if (failed) {
    if (lockedNow) writeAudit_(data.username, 'ACCOUNT_LOCKED', data.username, 'too many failed attempts');
    return { success: false, error: 'Invalid username or password' };
  }
  clearUsersCache_(); // otherwise a cached copy still says "idle for 40 min" and the fresh login is rejected for up to a minute

  const token = signToken_({
    sub: user.Username,
    iat: now.getTime(),
    exp: now.getTime() + TOKEN_ABSOLUTE_TTL_MS,
    epoch: epoch
  });

  if (idleLimitFor_(user) === IDLE_TIMEOUT_MS) writeAudit_(user.Username, 'LOGIN_SUCCESS', user.Username, ''); // sensitive accounts only: every other login is already stamped in Users (LastLogin), and each audit row costs ~1 s
  const out = {
    success: true,
    token: token,
    fullName: user.FullName,
    role: user.Role,
    assignedBus: user.AssignedBus,
    permissions: getUserPermissions_(user),
    committees: splitCsv_(user.Committees)
  };
  return out;
}

// Lets the UI refresh a user's permissions without logging in again.
function handleGetMyAccess_(data) {
  const auth = authorize_(data.token, null);
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };
  return {
    success: true,
    fullName: auth.user.FullName,
    role: auth.user.Role,
    assignedBus: auth.user.AssignedBus,
    permissions: getUserPermissions_(auth.user),
    committees: splitCsv_(auth.user.Committees)
  };
}

function authorize_(token, requiredCheckFn) {
  const verified = verifyTokenSignatureAndDecode_(token);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const payload = verified.payload;
  const now = Date.now();
  if (!payload.exp || now > payload.exp) return { ok: false, reason: 'EXPIRED' };

  const user = readUsersCached_().find(r => r.Username === payload.sub);
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
  if (user.Active !== true) return { ok: false, reason: 'ACCOUNT_DISABLED' };

  const currentEpoch = Number(user.TokenEpoch) || 0;
  if ((payload.epoch || 0) !== currentEpoch) return { ok: false, reason: 'REVOKED' };

  const lastActivity = user.LastActivityAt ? new Date(user.LastActivityAt).getTime() : 0;
  if (lastActivity && (now - lastActivity) > idleLimitFor_(user)) return { ok: false, reason: 'IDLE_TIMEOUT' };

  if (typeof requiredCheckFn === 'function' && !requiredCheckFn(user)) {
    return { ok: false, reason: 'FORBIDDEN' };
  }

  if (!lastActivity || (now - lastActivity) > ACTIVITY_WRITE_DEBOUNCE_MS) {
    // One cell, NO lock: a request must never wait for the busy write lock just to note "last activity"
    // (it used to wait up to 5 s, and under load an active user could even be timed out).
    // Safe without the lock: it runs only AFTER the token, epoch, active flag and idle limit were all checked,
    // it touches only LastActivityAt, and two simultaneous writes both store "now".
    try {
      const sheet = getSheetByName_(USERS_SHEET);
      const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      setCellByColumnName_(sheet, headers, user._rowNumber, 'LastActivityAt', new Date());
    } catch (e) {
      // best-effort
    }
  }

  return { ok: true, user: user };
}

const MIN_PASSWORD_LEN_ = 8;

function handleCreateUser_(data) {
  const { headers, sheet } = readSheetAsObjects_(USERS_SHEET);
  const isBootstrap = !usersSheetHasAnyUser_();
  let actorUsername = 'SYSTEM_BOOTSTRAP';

  if (isBootstrap) {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('BOOTSTRAP_USED') === 'true') {
      return { success: false, error: 'Bootstrap already used' };
    }
    if (data.bootstrapSecret !== getBootstrapSecret_()) {
      return { success: false, error: 'Invalid bootstrap secret' };
    }
  } else {
    const auth = authorize_(data.token, requirePerm_('manage'));
    if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };
    actorUsername = auth.user.Username;
    // Only an admin may create another admin (role "admin" or the "*" permission = full control).
    const wantsAll = data.role === 'admin' || (Array.isArray(data.permissions) && data.permissions.map(String).indexOf('*') !== -1);
    if (wantsAll && auth.user.Role !== 'admin') return { success: false, code: 'ADMIN_ONLY', error: 'إنشاء حساب إداري متاح للمدير فقط' };
  }

  if (findUserRow_(data.username)) {
    return { success: false, error: 'Username already exists' };
  }
  if (!isBootstrap && String(data.password || '').length < MIN_PASSWORD_LEN_) {
    return { success: false, code: 'WEAK_PASSWORD', error: 'كلمة المرور قصيرة: ' + MIN_PASSWORD_LEN_ + ' أحرف على الأقل' };
  }

  const { saltB64, hashHex } = hashPassword_(data.password);
  const role = isBootstrap ? 'admin' : data.role;
  const now = new Date();

  // Build the row by COLUMN NAME so adding/reordering columns never breaks this.
  const values = {
    Username: data.username,
    PasswordHash: hashHex,
    Salt: saltB64,
    FullName: data.fullName || '',
    Role: role,
    AssignedBus: data.assignedBus || '',
    Active: true,
    FailedAttempts: 0,
    LockedUntil: '',
    TokenEpoch: 0,
    LastActivityAt: '',
    CreatedAt: now,
    LastLogin: '',
    Committees: Array.isArray(data.committees) ? data.committees.join(',') : '',
    Permissions: Array.isArray(data.permissions) ? data.permissions.join(',') : ''
  };
  appendSafe_(sheet, headers.map(function(h) { return values.hasOwnProperty(h) ? values[h] : ''; }));
  clearUsersCache_();

  if (isBootstrap) {
    PropertiesService.getScriptProperties().setProperty('BOOTSTRAP_USED', 'true');
  }

  writeAudit_(actorUsername, isBootstrap ? 'BOOTSTRAP_CREATE_ADMIN' : 'CREATE_USER', data.username, 'role=' + role);
  return { success: true, username: data.username, role: role };
}

function revokeAllSessions_(username, actorUsername, reason) {
  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const user = rows.find(r => r.Username === username);
  if (!user) return { success: false, error: 'User not found' };

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const newEpoch = (Number(user.TokenEpoch) || 0) + 1;
    setCellByColumnName_(sheet, headers, user._rowNumber, 'TokenEpoch', newEpoch);
  } finally {
    lock.releaseLock();
  }
  writeAudit_(actorUsername, 'REVOKE_ALL_SESSIONS', username, reason || '');
  return { success: true };
}

// ---------------- Admin: user management (list / reset password / unlock) ----------------

function handleListUsers_(data) {
  const auth = authorize_(data.token, requireAnyPerm_(['manage', 'support']));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };

  const { rows } = readSheetAsObjects_(USERS_SHEET);
  const now = Date.now();
  const users = rows.map(r => {
    const isLocked = r.LockedUntil && new Date(r.LockedUntil).getTime() > now;
    return {
      username: r.Username,
      fullName: r.FullName,
      role: r.Role,
      assignedBus: r.AssignedBus,
      phone: String(r.Phone || ''),
      committees: splitCsv_(r.Committees),
      permissions: getUserPermissions_(r),
      active: r.Active === true,
      locked: !!isLocked,
      failedAttempts: Number(r.FailedAttempts) || 0,
      createdAt: r.CreatedAt ? String(r.CreatedAt) : '',
      lastLogin: r.LastLogin ? String(r.LastLogin) : ''
    };
  });
  return { success: true, users: users };
}

function handleResetPassword_(data) {
  const auth = authorize_(data.token, requireAnyPerm_(['manage', 'support']));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };

  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const target = rows.find(r => r.Username === data.targetUsername);
  if (!target) return { success: false, error: 'User not found' };
  if (!hasPerm_(auth.user, 'manage') && hasPerm_(target, 'manage')) {
    return { success: false, error: 'الدعم الفني لا يستطيع تغيير كلمة مرور حساب إداري' };
  }
  if (target.Role === 'admin' && auth.user.Role !== 'admin') {
    return { success: false, code: 'ADMIN_ONLY', error: 'كلمة مرور المدير يغيّرها المدير فقط' };
  }

  if (String(data.newPassword || '').length < MIN_PASSWORD_LEN_) {
    return { success: false, code: 'WEAK_PASSWORD', error: 'كلمة المرور قصيرة: ' + MIN_PASSWORD_LEN_ + ' أحرف على الأقل' };
  }
  const { saltB64, hashHex } = hashPassword_(data.newPassword);
  // Written under the lock from a FRESH read, so it cannot interleave with a login's password upgrade
  // and the session counter (TokenEpoch) is always incremented from its current value.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const fresh = readSheetAsObjects_(USERS_SHEET);
    const cur = fresh.rows.find(r => r.Username === target.Username);
    if (!cur) return { success: false, error: 'User not found' };
    setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'PasswordHash', hashHex);
    setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'Salt', saltB64);
    setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'FailedAttempts', 0);
    setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'LockedUntil', '');
    setCellByColumnName_(fresh.sheet, fresh.headers, cur._rowNumber, 'TokenEpoch', (Number(cur.TokenEpoch) || 0) + 1);
  } finally {
    lock.releaseLock();
  }

  writeAudit_(auth.user.Username, 'RESET_PASSWORD', data.targetUsername, '');
  return { success: true };
}

function handleUnlockAccount_(data) {
  const auth = authorize_(data.token, requireAnyPerm_(['manage', 'support']));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };

  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const target = rows.find(r => r.Username === data.targetUsername);
  if (!target) return { success: false, error: 'User not found' };

  const lock = LockService.getScriptLock(); // same cells as the failed-login counter: never interleave with it
  lock.waitLock(10000);
  try {
    setCellByColumnName_(sheet, headers, target._rowNumber, 'FailedAttempts', 0);
    setCellByColumnName_(sheet, headers, target._rowNumber, 'LockedUntil', '');
  } finally {
    lock.releaseLock();
  }

  writeAudit_(auth.user.Username, 'UNLOCK_ACCOUNT', data.targetUsername, '');
  return { success: true };
}

// Edit a user's display name from the app (no need to open the sheet).
function handleUpdateUserProfile_(data) {
  const auth = authorize_(data.token, requirePerm_('manage'));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason, code: auth.reason };
  const fullName = String(data.fullName || '').trim().slice(0, 60);
  if (fullName.length < 2) return { success: false, error: 'اكتب الاسم الكامل' };
  const phone = data.phone === undefined ? null : String(data.phone).replace(/[^0-9+]/g, '').slice(0, 20);
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
    const target = rows.find(function(r) { return r.Username === data.targetUsername; });
    if (!target) return { success: false, error: 'User not found' };
    if (target.Role === 'admin' && auth.user.Role !== 'admin') return { success: false, error: 'الحسابات الإدارية يعدّلها المدير فقط' };
    setCellByColumnName_(sheet, headers, target._rowNumber, 'FullName', fullName);
    if (phone !== null && headers.indexOf('Phone') !== -1) setCellByColumnName_(sheet, headers, target._rowNumber, 'Phone', phone);
    writeAudit_(auth.user.Username, 'USER_PROFILE_UPDATED', target.Username, '');
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// Enable / disable an account from the app (instead of editing the sheet). Takes effect on the very next request.
function handleSetUserActive_(data) {
  const auth = authorize_(data.token, requirePerm_('manage'));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason, code: auth.reason };
  if (typeof data.active !== 'boolean') return { success: false, error: 'Invalid request' };
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
    const target = rows.find(function(r) { return r.Username === data.targetUsername; });
    if (!target) return { success: false, error: 'User not found' };
    if (target.Username === auth.user.Username) return { success: false, error: 'لا يمكنك تعطيل حسابك بنفسك' };
    if (target.Role === 'admin' && auth.user.Role !== 'admin') return { success: false, error: 'الحسابات الإدارية يعدّلها المدير فقط' };
    setCellByColumnName_(sheet, headers, target._rowNumber, 'Active', data.active);
    writeAudit_(auth.user.Username, data.active ? 'USER_ENABLED' : 'USER_DISABLED', target.Username, '');
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------- Week 1: catalog + access management ----------------

// Active permission rows / committee rows straight from the sheet (so adding a row there = adding it here).
function readActiveCatalog_() {
  const perms = readSheetAsObjects_('PermissionsCatalog').rows
    .filter(function(r) { return r.Active === true && r.PermissionKey; })
    .map(function(r) { return { key: String(r.PermissionKey), label: r.Label, group: r.Group }; });
  const committees = readSheetAsObjects_('Committees').rows
    .filter(function(r) { return r.Active === true && r.CommitteeID; })
    .sort(function(a, b) { return (Number(a.SortOrder) || 0) - (Number(b.SortOrder) || 0); })
    .map(function(r) { return { id: String(r.CommitteeID), name: r.Name, type: r.Type }; });
  return { permissions: perms, committees: committees };
}

function handleGetCatalog_(data) {
  const auth = authorize_(data.token, requirePerm_('manage'));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };
  const cat = readActiveCatalog_();
  return { success: true, permissions: cat.permissions, committees: cat.committees };
}

function handleUpdateUserAccess_(data) {
  const auth = authorize_(data.token, requirePerm_('manage'));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };

  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
    const target = rows.find(function(r) { return r.Username === data.targetUsername; });
    if (!target) return { success: false, error: 'User not found' };

    const perms = Array.isArray(data.permissions) ? data.permissions.map(String) : [];
    const committees = Array.isArray(data.committees) ? data.committees.map(String) : [];

    const cat = readActiveCatalog_();
    const okKeys = cat.permissions.map(function(p) { return p.key; });
    const okCommittees = cat.committees.map(function(c) { return c.id; });
    const badKey = perms.find(function(k) { return okKeys.indexOf(k) === -1; });
    if (badKey) return { success: false, error: 'Unknown permission: ' + badKey };
    const badCom = committees.find(function(c) { return okCommittees.indexOf(c) === -1; });
    if (badCom) return { success: false, error: 'Unknown committee: ' + badCom };

    // Safety: a non-admin cannot remove their own "manage" (admins always keep everything).
    if (target.Username === auth.user.Username && auth.user.Role !== 'admin' && perms.indexOf('manage') === -1) {
      return { success: false, error: 'لا يمكنك سحب صلاحية إدارة المستخدمين من نفسك' };
    }

    setCellByColumnName_(sheet, headers, target._rowNumber, 'Permissions', perms.join(','));
    setCellByColumnName_(sheet, headers, target._rowNumber, 'Committees', committees.join(','));
    if (data.assignedBus !== undefined) {
      setCellByColumnName_(sheet, headers, target._rowNumber, 'AssignedBus', String(data.assignedBus).trim());
    }
    writeAudit_(auth.user.Username, 'UPDATE_ACCESS', target.Username,
      'permissions=' + perms.join('|') + '; committees=' + committees.join('|'));
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------------- Week 1: one-time setup (safe to run more than once) ----------------

const COMMITTEES_SEED_ = [
  ['C01', 'السكرتارية', 'إدارية', false], ['C02', 'المشرفين', 'إدارية', false],
  ['C03', 'المالية', 'إدارية', false], ['C04', 'العليا', 'إدارية', false],
  ['C05', 'الإدارية', 'إدارية', false],
  ['C06', 'أنشطة الصفوف (4-6)', 'فعاليات', true], ['C07', 'الأنشطة الدينية الصفوف (7-9)', 'فعاليات', true],
  ['C08', 'الأنشطة الرياضية الصفوف (7-9)', 'فعاليات', true], ['C09', 'أنشطة الصفوف (10-11)', 'فعاليات', true],
  ['C10', 'الدينية العامة', 'فعاليات', true], ['C11', 'الكشفية', 'فعاليات', true],
  ['C12', 'المسرح', 'فعاليات', true], ['C13', 'الرحلة الخارجية', 'فعاليات', true],
  ['C14', 'الإعلامية', 'خدمية', false], ['C15', 'الإذاعية', 'خدمية', false],
  ['C16', 'الطبية', 'خدمية', false], ['C17', 'التغذية', 'خدمية', false],
  ['C18', 'المقهى', 'خدمية', false], ['C19', 'البقالة', 'خدمية', false],
  ['C20', 'الخدمات', 'خدمية', false], ['C21', 'المخزن والمشتريات', 'خدمية', false],
  ['C22', 'الكهرباء والماء والأعطال والصوتيات (اللوجستية)', 'خدمية', false],
  ['C23', 'الوثائق والتطور التقني', 'خدمية', false], ['C24', 'الاجتماعية', 'خدمية', false]
];

const PERMISSIONS_SEED_ = [
  ['checkin', 'تسجيل الحضور', 'شاشة'], ['dashboard', 'لوحة المعلومات', 'شاشة'],
  ['committee', 'مصاريف اللجنة', 'شاشة'], ['finance', 'اعتماد المصاريف', 'شاشة'],
  ['shirts', 'توزيع القمصان', 'شاشة'], ['team', 'الفريق والإعلانات', 'شاشة'],
  ['users', 'المستخدمون', 'شاشة'], ['results', 'إدخال النتائج', 'شاشة'],
  ['medical', 'الصفحة الطبية', 'شاشة'],
  ['allbuses', 'تسجيل حضور كل الباصات', 'خاصة'], ['approve', 'اعتماد المصاريف', 'خاصة'],
  ['addstudent', 'إضافة طلاب يدوياً', 'خاصة'], ['manage', 'إدارة المستخدمين', 'خاصة'],
  ['verify', 'التحقق من النتائج', 'خاصة'], ['announce', 'نشر الإعلانات', 'خاصة'],
  ['budget', 'تحديد ميزانيات اللجان', 'خاصة'],
  ['support', 'الدعم الفني (كلمات المرور وفك القفل)', 'خاصة'],
  ['print', 'طباعة الأساور والكشوف', 'خاصة'],
  ['undo', 'التراجع عن تسجيل صعود أي طالب في أي وقت (المشرف العام)', 'خاصة'],
  ['custody', 'الأمانات (هواتف وحقائب) واستئذان الخروج', 'شاشة'],
  ['gate', 'البوابة (الكشافة): تأكيد خروج من وافقت السكرتارية على خروجه', 'شاشة'],
  ['nutrition', 'التغذية (أعداد الوجبات والحساسية الغذائية)', 'شاشة'],
  ['reports', 'التقارير (استخراج وطباعة) — للسكرتارية', 'شاشة'],
  ['reception', 'الوصول المباشر: طلاب وصلوا مع ولي أمرهم أو متأخرين (بدون الباص) وتسجيل المتأخرين', 'شاشة'],
  ['stages', 'المراحل: بدء وإنهاء مراحل الوصول والرحلة والمغادرة — للسكرتارية', 'شاشة']
];

// Creates the sheet if missing, and appends any missing header columns (never deletes anything).
function ensureSheetWithHeaders_(ss, name, headers, log) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    log.push('أُنشئ تبويب ' + name);
    return sheet;
  }
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = headers.filter(function(h) { return existing.indexOf(h) === -1; });
  if (missing.length > 0) {
    const startCol = existing.filter(function(h) { return h !== ''; }).length + 1;
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
    log.push('أُضيفت أعمدة إلى ' + name + ': ' + missing.join(', '));
  } else {
    log.push(name + ': لا تغيير');
  }
  return sheet;
}

function SETUP_createTabs() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(SHEET_MEMO_).forEach(function(k) { delete SHEET_MEMO_[k]; });
  const log = [];

  ensureSheetWithHeaders_(ss, 'Users', ['Committees', 'Permissions', 'Phone'], log);

  const com = ensureSheetWithHeaders_(ss, 'Committees',
    ['CommitteeID', 'Name', 'Type', 'ResultsEnabled', 'Budget', 'SortOrder', 'Active'], log);
  if (com.getLastRow() < 2) {
    const rows = COMMITTEES_SEED_.map(function(c, i) { return [c[0], c[1], c[2], c[3], '', i + 1, true]; });
    com.getRange(2, 1, rows.length, 7).setValues(rows);
    log.push('عُبِّئت ' + rows.length + ' لجنة');
  }

  const cat = ensureSheetWithHeaders_(ss, 'PermissionsCatalog',
    ['PermissionKey', 'Label', 'Group', 'Active'], log);
  const existingKeys = cat.getLastRow() < 2 ? [] :
    cat.getRange(2, 1, cat.getLastRow() - 1, 1).getValues().map(function(r) { return String(r[0]); });
  const toAdd = PERMISSIONS_SEED_.filter(function(p) { return existingKeys.indexOf(p[0]) === -1; })
    .map(function(p) { return [p[0], p[1], p[2], true]; });
  if (toAdd.length > 0) {
    cat.getRange(cat.getLastRow() + 1, 1, toAdd.length, 4).setValues(toAdd);
    log.push('أُضيفت ' + toAdd.length + ' صلاحية');
  }

  ensureSheetWithHeaders_(ss, 'Scans', ['Time', 'StudentID', 'Action', 'Bus', 'Supervisor', 'Method', 'ClientId', 'Notes', 'StageId'], log);
  ensureSheetWithHeaders_(ss, 'Bags', ['Time', 'StudentID', 'Bus', 'Mode', 'Count', 'Expected', 'Supervisor', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'BusLive', ['Bus', 'Status', 'Lat', 'Lng', 'Accuracy', 'UpdatedAt', 'Supervisor', 'Boarded', 'Total', 'Speed'], log);

  ensureSheetWithHeaders_(ss, 'Custody', ['Time', 'StudentID', 'Item', 'Action', 'Count', 'Tag', 'By', 'ClientId', 'Notes'], log);
  ensureSheetWithHeaders_(ss, 'Withdrawals', ['Id', 'StudentID', 'Time', 'GuardianName', 'Reason', 'Status', 'CreatedBy', 'ClosedAt', 'ClosedBy', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'MedicalCases', ['Id', 'StudentID', 'OpenedAt', 'OpenedBy', 'Severity', 'Complaint', 'Treatment', 'Status', 'ClosedAt', 'ClosedBy', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'Announcements', ['Id', 'CreatedAt', 'Title', 'Body', 'Kind', 'StartsAt', 'Audience', 'Pinned', 'Status', 'CreatedBy', 'PublishedAt', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'Results', ['Id', 'CreatedAt', 'Competition', 'Team', 'Place', 'Points', 'Status', 'CreatedBy', 'PublishedAt', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'Staff', ['Name', 'Size', 'Note'], log);
  ensureSheetWithHeaders_(ss, 'ShirtStock', ['Size', 'Total', 'LowAt'], log);
  ensureSheetWithHeaders_(ss, 'ShirtLog', ['Id', 'Time', 'Kind', 'PersonId', 'Name', 'Size', 'GivenBy', 'Status', 'Note', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'ExtraStudents', ['Id', 'Name', 'Class', 'Team', 'Bus', 'Shirt', 'Note', 'AddedAt', 'AddedBy', 'Active', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'Rounds', ['Time', 'Bus', 'Phase', 'Supervisor', 'Checked', 'Absent', 'Total', 'AbsentIds', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'Cases', ['Id', 'Time', 'Type', 'Bus', 'StudentID', 'Text', 'Status', 'CreatedBy', 'UpdatedBy', 'ClientId'], log);

  const msg = log.join('\n');
  Logger.log(msg);
  return msg;
}


// Turns the camp STAGES on (run once from the editor): creates the Stages tab with the six stages and their date + time windows.
// From then on a scan is accepted only inside a stage's window and only for the students that stage includes.
// Safe to run again: it only fills what is missing (a stage whose Date / From / To are empty gets the planned ones); it never overwrites.
// To turn stages off, delete the Stages tab.
function SETUP_createStages() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  Object.keys(SHEET_MEMO_).forEach(function(k) { delete SHEET_MEMO_[k]; });
  const log = [];
  ensureSheetWithHeaders_(ss, 'Scans', ['Time', 'StudentID', 'Action', 'Bus', 'Supervisor', 'Method', 'ClientId', 'Notes', 'StageId'], log);
  const sh = ensureSheetWithHeaders_(ss, 'Stages', STAGES_HEADERS_, log);
  const v = sh.getDataRange().getValues(), h = v[0].map(String), col = function(n) { return h.indexOf(n); };
  STAGES_SEED_.forEach(function(seed) {
    const want = {}; STAGES_HEADERS_.forEach(function(n, k) { want[n] = seed[k]; });
    let r = -1; for (let i = 1; i < v.length; i++) if (String(v[i][col('StageId')]).trim() === seed[0]) { r = i; break; }
    if (r === -1) { sh.appendRow(h.map(function(n) { return want[n] === undefined ? '' : want[n]; })); log.push('أُضيفت مرحلة ' + seed[0]); return; }
    ['Date', 'From', 'To'].forEach(function(n) {
      if (col(n) !== -1 && String(v[r][col(n)]).trim() === '') { sh.getRange(r + 1, col(n) + 1).setValue(want[n]); log.push(seed[0] + ': ' + n + ' = ' + String(want[n]).replace(/^'/, '')); }
    });
  });
  clearStagesCache_();
  const msg = log.join('\n');
  Logger.log(msg);
  return msg;
}

// Emergency recovery, run from the Apps Script editor by the owner (never reachable from the web).
// 1) Type the username and the new password below.  2) Run ADMIN_resetPassword.
// 3) IMPORTANT: delete the password text from the line below and save.
function ADMIN_resetPassword() {
  const USERNAME = 'admin_test';
  const NEW_PASSWORD = 'PUT-NEW-PASSWORD-HERE';
  if (NEW_PASSWORD === 'PUT-NEW-PASSWORD-HERE' || String(NEW_PASSWORD).length < MIN_PASSWORD_LEN_) {
    throw new Error('اكتب كلمة مرور جديدة (8 أحرف على الأقل) في السطر NEW_PASSWORD ثم شغّل الدالة');
  }
  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const target = rows.find(function(r) { return r.Username === USERNAME; });
  if (!target) throw new Error('المستخدم غير موجود: ' + USERNAME);
  const lock = LockService.getScriptLock(); lock.waitLock(10000); // same lock as login / revoke (TokenEpoch is written by all of them)
  try {
  const h = hashPassword_(NEW_PASSWORD);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'PasswordHash', h.hashHex);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'Salt', h.saltB64);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'FailedAttempts', 0);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'LockedUntil', '');
  setCellByColumnName_(sheet, headers, target._rowNumber, 'Active', true);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'TokenEpoch', (Number(target.TokenEpoch) || 0) + 1);
  writeAudit_('EDITOR_OWNER', 'RESET_PASSWORD', USERNAME, 'from the script editor');
  Logger.log('تم تغيير كلمة مرور ' + USERNAME + '. احذف كلمة المرور من الكود الآن.');
  } finally { lock.releaseLock(); }
}


// Optional speed-up: Apps Script "goes to sleep" when idle and the first request after a pause is slow.
// Run ADMIN_installKeepWarm ONCE from the editor to create a trigger that pings the service every 5 minutes.
function keepWarm_() { SpreadsheetApp.openById(SHEET_ID).getName(); }
function ADMIN_installKeepWarm() {
  ScriptApp.getProjectTriggers().forEach(function(t) { if (t.getHandlerFunction() === 'keepWarm_') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('keepWarm_').timeBased().everyMinutes(5).create();
  Logger.log('تم تفعيل التسخين الدوري كل 5 دقائق');
}
