import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

const SESSION_COOKIE = 'warrior_session'

export function normalizeUsername(value) {
  return String(value || '').normalize('NFKC').trim()
}

export function validateUsername(value) {
  const username = normalizeUsername(value)
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(username)) throw httpError(400, '用户名需为 3–32 位字母、数字、下划线或连字符', 'INVALID_USERNAME')
  return username
}

export function validatePassword(value) {
  const password = String(value || '')
  if (password.length < 8 || password.length > 128) throw httpError(400, '密码需为 8–128 个字符', 'INVALID_PASSWORD')
  return password
}

export function normalizePhone(value) {
  const phone = String(value || '').replace(/[\s()+-]/g, '')
  if (!/^\d{6,20}$/.test(phone)) throw httpError(400, '请填写有效手机号', 'INVALID_PHONE')
  return phone
}

export function phoneDigest(phone, secret) {
  return createHash('sha256').update(`${secret}\0${phone}`).digest('hex')
}

export function passwordRecord(password) {
  const salt = randomBytes(16)
  return { salt: salt.toString('hex'), hash: scryptSync(password, salt, 64).toString('hex') }
}

export function passwordMatches(password, saltHex, expectedHex) {
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function createSession(db, res, userId, { remember = true, secure = false } = {}) {
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  const maxAge = remember ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)')
    .run(sessionHash(token), userId, new Date(now.getTime() + maxAge).toISOString(), now.toISOString())
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    ...(remember ? { maxAge } : {})
  })
}

export function clearSession(db, req, res, secure = false) {
  const token = req.cookies?.[SESSION_COOKIE]
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sessionHash(token))
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' })
}

export function sessionUser(db, req) {
  const token = req.cookies?.[SESSION_COOKIE]
  if (!token) return null
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?
  `).get(sessionHash(token), new Date().toISOString())
  return row || null
}

export function privateUser(row) {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    role: row.role,
    phoneMasked: row.phone_last4 ? `*******${row.phone_last4}` : null
  }
}

export function insertUser(db, { username, password, nickname, phone, role = 'user', phoneSecret }) {
  const id = randomUUID()
  const now = new Date().toISOString()
  const record = passwordRecord(password)
  const phoneValue = role === 'admin' ? null : normalizePhone(phone)
  db.prepare(`INSERT INTO users
    (id,username,password_hash,password_salt,nickname,phone_hash,phone_last4,role,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, username, record.hash, record.salt, nickname,
      phoneValue ? phoneDigest(phoneValue, phoneSecret) : null,
      phoneValue ? phoneValue.slice(-4) : null, role, now, now
    )
  return db.prepare('SELECT * FROM users WHERE id=?').get(id)
}

export function httpError(status, message, code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}

export { SESSION_COOKIE }
