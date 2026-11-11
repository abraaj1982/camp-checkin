// ============================================================
// MUKHAYYAM — Auth Layer (PRODUCTION) — Phase 1
// ============================================================

const USERS_SHEET = 'Users';
const SETTINGS_SHEET = 'Settings';
const AUDIT_SHEET = 'AuditLog';

const TOKEN_ABSOLUTE_TTL_MS = 3 * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
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

function getSheetByName_(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
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

function colIndexByName_(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error('Column not found: ' + name);
  return idx + 1;
}

function setCellByColumnName_(sheet, headers, rowNumber, columnName, value) {
  sheet.getRange(rowNumber, colIndexByName_(headers, columnName)).setValue(value);
}

function getSetting_(key) {
  const { rows } = readSheetAsObjects_(SETTINGS_SHEET);
  const row = rows.find(r => r.Key === key);
  return row ? row.Value : null;
}

function setSetting_(key, value) {
  const { rows, headers, sheet } = readSheetAsObjects_(SETTINGS_SHEET);
  const existing = rows.find(r => r.Key === key);
  if (existing) {
    setCellByColumnName_(sheet, headers, existing._rowNumber, 'Value', value);
  } else {
    sheet.appendRow([key, value]);
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
  sheet.appendRow([new Date(), actor, action, target || '', details || '']);
}

function findUserRow_(username) {
  const { rows } = readSheetAsObjects_(USERS_SHEET);
  return rows.find(r => r.Username === username);
}

// Batched write of FailedAttempts, LockedUntil, TokenEpoch, LastActivityAt,
// CreatedAt, LastLogin in ONE range call instead of 6 separate setValue()
// calls — these 6 columns are contiguous (H:M) by design.
function writeLoginSuccessRow_(sheet, headers, user, now) {
  const startCol = colIndexByName_(headers, 'FailedAttempts');
  sheet.getRange(user._rowNumber, startCol, 1, 6).setValues([[
    0,                         // FailedAttempts
    '',                        // LockedUntil
    Number(user.TokenEpoch) || 0, // TokenEpoch (unchanged)
    now,                       // LastActivityAt
    user.CreatedAt,            // CreatedAt (unchanged)
    now                        // LastLogin
  ]]);
}

function handleLogin_(data) {
  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const user = rows.find(r => r.Username === data.username);
  if (!user) return { success: false, error: 'Invalid username or password' };

  const now = new Date();
  if (user.LockedUntil && new Date(user.LockedUntil) > now) {
    return { success: false, error: 'Account temporarily locked. Try again later.' };
  }
  if (user.Active !== true) {
    return { success: false, error: 'Account disabled' };
  }

  const passwordOk = verifyPassword_(data.password, user.Salt, user.PasswordHash);
  if (!passwordOk) {
    const attempts = (Number(user.FailedAttempts) || 0) + 1;
    setCellByColumnName_(sheet, headers, user._rowNumber, 'FailedAttempts', attempts);
    if (attempts >= MAX_FAILED_ATTEMPTS) {
      setCellByColumnName_(sheet, headers, user._rowNumber, 'LockedUntil', new Date(now.getTime() + LOCKOUT_MS));
      writeAudit_(data.username, 'ACCOUNT_LOCKED', data.username, 'too many failed attempts');
    }
    return { success: false, error: 'Invalid username or password' };
  }

  writeLoginSuccessRow_(sheet, headers, user, now);

  const epoch = Number(user.TokenEpoch) || 0;
  const token = signToken_({
    sub: user.Username,
    iat: now.getTime(),
    exp: now.getTime() + TOKEN_ABSOLUTE_TTL_MS,
    epoch: epoch
  });

  writeAudit_(user.Username, 'LOGIN_SUCCESS', user.Username, '');
  return {
    success: true,
    token: token,
    fullName: user.FullName,
    role: user.Role,
    assignedBus: user.AssignedBus,
    permissions: getUserPermissions_(user),
    committees: splitCsv_(user.Committees)
  };
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

  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const user = rows.find(r => r.Username === payload.sub);
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };
  if (user.Active !== true) return { ok: false, reason: 'ACCOUNT_DISABLED' };

  const currentEpoch = Number(user.TokenEpoch) || 0;
  if ((payload.epoch || 0) !== currentEpoch) return { ok: false, reason: 'REVOKED' };

  const lastActivity = user.LastActivityAt ? new Date(user.LastActivityAt).getTime() : 0;
  if (lastActivity && (now - lastActivity) > IDLE_TIMEOUT_MS) return { ok: false, reason: 'IDLE_TIMEOUT' };

  if (typeof requiredCheckFn === 'function' && !requiredCheckFn(user)) {
    return { ok: false, reason: 'FORBIDDEN' };
  }

  if (!lastActivity || (now - lastActivity) > ACTIVITY_WRITE_DEBOUNCE_MS) {
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(5000);
      setCellByColumnName_(sheet, headers, user._rowNumber, 'LastActivityAt', new Date());
    } catch (e) {
      // best-effort
    } finally {
      lock.releaseLock();
    }
  }

  return { ok: true, user: user };
}

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
  }

  if (findUserRow_(data.username)) {
    return { success: false, error: 'Username already exists' };
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
  sheet.appendRow(headers.map(function(h) { return values.hasOwnProperty(h) ? values[h] : ''; }));

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

  const { saltB64, hashHex } = hashPassword_(data.newPassword);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'PasswordHash', hashHex);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'Salt', saltB64);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'FailedAttempts', 0);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'LockedUntil', '');
  const newEpoch = (Number(target.TokenEpoch) || 0) + 1;
  setCellByColumnName_(sheet, headers, target._rowNumber, 'TokenEpoch', newEpoch);

  writeAudit_(auth.user.Username, 'RESET_PASSWORD', data.targetUsername, '');
  return { success: true };
}

function handleUnlockAccount_(data) {
  const auth = authorize_(data.token, requireAnyPerm_(['manage', 'support']));
  if (!auth.ok) return { success: false, error: 'Not authorized: ' + auth.reason };

  const { headers, sheet, rows } = readSheetAsObjects_(USERS_SHEET);
  const target = rows.find(r => r.Username === data.targetUsername);
  if (!target) return { success: false, error: 'User not found' };

  setCellByColumnName_(sheet, headers, target._rowNumber, 'FailedAttempts', 0);
  setCellByColumnName_(sheet, headers, target._rowNumber, 'LockedUntil', '');

  writeAudit_(auth.user.Username, 'UNLOCK_ACCOUNT', data.targetUsername, '');
  return { success: true };
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
  ['print', 'طباعة الأساور والكشوف', 'خاصة']
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
  const log = [];

  ensureSheetWithHeaders_(ss, 'Users', ['Committees', 'Permissions'], log);

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

  ensureSheetWithHeaders_(ss, 'Scans', ['Time', 'StudentID', 'Action', 'Bus', 'Supervisor', 'Method', 'ClientId', 'Notes'], log);
  ensureSheetWithHeaders_(ss, 'Bags', ['Time', 'StudentID', 'Bus', 'Mode', 'Count', 'Expected', 'Supervisor', 'ClientId'], log);
  ensureSheetWithHeaders_(ss, 'BusLive', ['Bus', 'Status', 'Lat', 'Lng', 'Accuracy', 'UpdatedAt', 'Supervisor', 'Boarded', 'Total'], log);

  const msg = log.join('\n');
  Logger.log(msg);
  return msg;
}
