import express from 'express'
import cookieParser from 'cookie-parser'
import { ipKeyGenerator, rateLimit } from 'express-rate-limit'
import sharp from 'sharp'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isIP } from 'node:net'
import {
  clearSession, createSession, httpError, insertUser, normalizePhone, normalizeUsername,
  passwordMatches, passwordRecord, phoneDigest, privateUser, sessionUser, validatePassword,
  validateUsername
} from './auth.js'
import { openDatabase, resolveDataDir, transaction } from './db.js'
import { createLocalDemoModeration, createModerationAdapter, LOCAL_DEMO_MESSAGE, UNCONFIGURED_MESSAGE } from './moderation.js'
import { createQwenModerator } from './qwen-moderation.js'

const JSON_LIMIT = '64kb'
const UPLOAD_LIMIT = 2 * 1024 * 1024
const UPLOAD_COUNT_LIMIT = 40
const UPLOAD_STORAGE_LIMIT = 20 * 1024 * 1024
const PAGE_SIZE = 18
const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost'])

export function createApp(options = {}) {
  const env = { ...process.env, ...(options.env || {}) }
  const production = options.production ?? env.NODE_ENV === 'production'
  const localDemo = options.localDemo ?? env.LOCAL_DEMO === '1'
  const host = options.host || env.HOST || '127.0.0.1'
  if (localDemo && (production || !LOOPBACKS.has(host))) throw new Error('LOCAL_DEMO=1 仅允许在非生产的本机回环地址上运行')
  const appOrigin = options.appOrigin || env.APP_ORIGIN || (production ? '' : 'http://localhost:5173')
  if (!appOrigin) throw new Error('生产环境必须配置 APP_ORIGIN')
  const allowedOrigins = new Set(options.allowedOrigins || appOrigin.split(',').map((v) => v.trim()).filter(Boolean))
  const deploymentDomains = options.deploymentDomains || (env.DEPLOYMENT_DOMAINS || 'workbuddy.link,www.workbuddy.link').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean)
  const dataDir = resolveDataDir(options.dataDir || env.DATA_DIR || join(process.cwd(), localDemo ? 'data-demo' : 'data'))
  const mediaDir = join(dataDir, 'media')
  mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
  const db = options.db || openDatabase(dataDir, options.dbFilename)
  // 过期会话不参与鉴权，但会一直留在表里；每次启动清一次，避免无限增长。
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now())
  const phoneSecret = options.phoneSecret || env.PHONE_HASH_SECRET || 'warrior-base-local-phone-digest'
  if (production && !options.phoneSecret && !env.PHONE_HASH_SECRET) throw new Error('生产环境必须配置 PHONE_HASH_SECRET')
  const moderator = options.moderator || (localDemo
    ? createLocalDemoModeration()
    : env.MODERATION_API_KEY
      ? createQwenModerator({
          apiKey: env.MODERATION_API_KEY,
          baseUrl: env.MODERATION_BASE_URL,
          textModel: env.MODERATION_TEXT_MODEL,
          visionModel: env.MODERATION_VISION_MODEL,
          dataDir,
          dailyLimit: positiveEnvNumber(env.MODERATION_DAILY_LIMIT, 1000),
          fetchImpl: options.fetchImpl
        })
      : createModerationAdapter({ url: env.MODERATION_URL, token: env.MODERATION_TOKEN, fetchImpl: options.fetchImpl }))
  const mode = localDemo ? 'local-demo' : 'live'
  const secureCookie = production
  let activeImageJobs = 0

  const app = express()
  app.locals.db = db
  app.locals.config = { dataDir, mediaDir, mode, production, host, moderator, deploymentDomains }
  if (options.trustProxy === true || env.TRUST_PROXY === '1') app.set('trust proxy', 'loopback')
  app.disable('x-powered-by')
  app.use(cookieParser())
  app.use(express.json({ limit: JSON_LIMIT }))
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    next()
  })
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    req.user = sessionUser(db, req)
    next()
  })
  app.use('/api', (req, _res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next()
    const origin = req.get('origin')
    if (!origin || !allowedOrigins.has(origin)) return next(httpError(403, '请求来源不被允许', 'BAD_ORIGIN'))
    next()
  })

  const registerIpLimiter = limiter(60, 15 * 60 * 1000)
  const loginIpLimiter = limiter(200, 15 * 60 * 1000)
  const recoveryIpLimiter = limiter(100, 15 * 60 * 1000)
  const recoveryAccountLimiter = limiter(5, 15 * 60 * 1000, (req) => {
    const username = normalizeUsername(req.body?.username).toLowerCase()
    return username ? `account:${createHash('sha256').update(username).digest('hex')}` : `ip:${ipKeyGenerator(req.ip)}`
  })
  const uploadIpLimiter = limiter(1000, 60 * 60 * 1000)
  const uploadUserLimiter = limiter(40, 60 * 60 * 1000, (req) => `user:${req.user.id}`)
  const reportLimiter = limiter(20, 60 * 60 * 1000, (req) => req.user ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`)
  const contentIpLimiter = limiter(1000, 60 * 60 * 1000)
  const contentUserLimiter = limiter(100, 60 * 60 * 1000, (req) => `user:${req.user.id}`)
  const likeIpLimiter = limiter(3000, 60 * 60 * 1000)
  const likeUserLimiter = limiter(200, 60 * 60 * 1000, (req) => `user:${req.user.id}`)

  app.get('/api/health', (_req, res) => res.json({ ok: true, mode, moderationReady: moderator.ready === true }))
  app.get('/api/me', (req, res) => res.json({ user: req.user ? privateUser(req.user) : null, mode, moderationReady: moderator.ready === true }))

  app.post('/api/auth/register', registerIpLimiter, async (req, res) => {
    const username = validateUsername(req.body?.username)
    const password = validatePassword(req.body?.password)
    const requestedNickname = validateNickname(req.body?.nickname)
    const phone = normalizePhone(req.body?.phone)
    let user
    try {
      user = insertUser(db, { username, password, nickname: `勇士${randomUUID().slice(0, 4)}`, phone, phoneSecret })
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw httpError(409, '用户名已被使用', 'USERNAME_TAKEN')
      throw error
    }
    let nicknameResult
    try {
      nicknameResult = await moderateSnapshot({ input: { title: '', description: '', url: '', coverId: null }, nickname: requestedNickname, moderator, db, mediaDir })
    } catch {
      nicknameResult = { decision: 'review', reason: '昵称自动审核暂未完成' }
    }
    if (nicknameResult?.decision === 'allow') {
      db.prepare('UPDATE users SET nickname=?,updated_at=? WHERE id=?').run(requestedNickname, now(), user.id)
    } else if (nicknameResult?.decision === 'review') {
      db.prepare('UPDATE users SET pending_nickname=?,profile_moderation_reason=?,updated_at=? WHERE id=?').run(requestedNickname, safeReason(nicknameResult.reason), now(), user.id)
    } else {
      db.prepare('UPDATE users SET profile_moderation_reason=?,updated_at=? WHERE id=?').run(safeReason(nicknameResult?.reason || '昵称未通过审核'), now(), user.id)
    }
    user = db.prepare('SELECT * FROM users WHERE id=?').get(user.id)
    createSession(db, res, user.id, { remember: req.body?.remember !== false, secure: secureCookie })
    res.status(201).json({ user: privateUser(user) })
  })

  app.post('/api/auth/login', loginIpLimiter, (req, res) => {
    const username = normalizeUsername(req.body?.username)
    const password = String(req.body?.password || '')
    if (loginFailureBlocked(db, username)) throw httpError(429, '该账号登录失败过多，请稍后再试', 'RATE_LIMITED')
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username)
    if (!user || !passwordMatches(password, user.password_salt, user.password_hash)) {
      const failures = recordLoginFailure(db, username)
      if (failures >= 10) throw httpError(429, '该账号登录失败过多，请稍后再试', 'RATE_LIMITED')
      throw httpError(401, '用户名或密码错误', 'INVALID_CREDENTIALS')
    }
    clearLoginFailures(db, username)
    createSession(db, res, user.id, { remember: req.body?.remember !== false, secure: secureCookie })
    res.json({ user: privateUser(user) })
  })

  app.post('/api/auth/logout', (req, res) => {
    clearSession(db, req, res, secureCookie)
    res.json({ ok: true })
  })

  app.post('/api/auth/recover', recoveryIpLimiter, recoveryAccountLimiter, (req, res) => {
    const username = normalizeUsername(req.body?.username)
    const phone = normalizePhone(req.body?.phone)
    const newPassword = validatePassword(req.body?.newPassword)
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE AND phone_hash=?').get(username, phoneDigest(phone, phoneSecret))
    if (!user || user.role === 'admin') throw httpError(400, '找回信息不匹配', 'RECOVERY_MISMATCH')
    const record = passwordRecord(newPassword)
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(record.hash, record.salt, now(), user.id)
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
    })
    clearSession(db, req, res, secureCookie)
    res.json({ ok: true })
  })

  app.get('/api/works', (req, res) => {
    const lesson = optionalLesson(req.query.lesson)
    const page = positiveInt(req.query.page, 1)
    const q = cleanText(req.query.q, 80).toLowerCase()
    const clauses = [`w.status='published'`, 'w.approved_version_id IS NOT NULL']
    const params = []
    if (lesson) { clauses.push('w.lesson=?'); params.push(lesson) }
    if (q) { clauses.push(`(LOWER(v.title) LIKE ? ESCAPE '\\' OR LOWER(v.description) LIKE ? ESCAPE '\\' OR LOWER(u.nickname) LIKE ? ESCAPE '\\')`); params.push(...Array(3).fill(`%${escapeLike(q)}%`)) }
    const where = clauses.join(' AND ')
    const total = Number(db.prepare(`SELECT COUNT(*) count FROM works w JOIN work_versions v ON v.id=w.approved_version_id JOIN users u ON u.id=w.user_id WHERE ${where}`).get(...params).count)
    const base = publicWorkSql(req.user?.id)
    const rows = db.prepare(`${base.sql} WHERE ${where} ORDER BY w.updated_at DESC LIMIT ? OFFSET ?`).all(...base.params, ...params, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    res.json({ works: rows.map((row) => publicWork(row)), total, page, pageSize: PAGE_SIZE })
  })

  app.get('/api/works/:id', (req, res) => {
    const base = publicWorkSql(req.user?.id)
    const row = db.prepare(`${base.sql} WHERE w.id=? AND w.status='published' AND w.approved_version_id IS NOT NULL`).get(...base.params, req.params.id)
    if (!row) throw httpError(404, '作品不存在', 'NOT_FOUND')
    res.json({ work: publicWork(row) })
  })

  app.get('/api/profiles/:id', (req, res) => {
    const user = db.prepare(`SELECT id,nickname FROM users WHERE id=? AND EXISTS(
      SELECT 1 FROM works WHERE user_id=users.id AND status='published' AND approved_version_id IS NOT NULL
    )`).get(req.params.id)
    if (!user) throw httpError(404, '用户不存在', 'NOT_FOUND')
    const base = publicWorkSql(req.user?.id)
    const rows = db.prepare(`${base.sql} WHERE w.user_id=? AND w.status='published' AND w.approved_version_id IS NOT NULL ORDER BY w.lesson`).all(...base.params, user.id)
    res.json({ profile: user, works: rows.map((row) => publicWork(row)) })
  })

  app.get('/api/mine', requireUser, (req, res) => {
    const works = db.prepare('SELECT * FROM works WHERE user_id=? ORDER BY lesson').all(req.user.id).map((row) => ownerWork(db, row, req.user.id))
    res.json({ works })
  })

  app.post('/api/works', requireUser, contentIpLimiter, contentUserLimiter, async (req, res) => {
    const lesson = requiredLesson(req.body?.lesson)
    if (db.prepare('SELECT 1 FROM works WHERE user_id=? AND lesson=?').get(req.user.id, lesson)) throw httpError(409, '这一讲已有作品，请编辑原作品', 'LESSON_CONFLICT')
    const input = validateWorkInput(req.body, { deploymentDomains, db, userId: req.user.id })
    const publish = req.body?.publish === true
    if (publish && req.body?.consent !== true) throw httpError(400, '发布前需明确同意公开展示', 'CONSENT_REQUIRED')
    if (publish && moderator.ready === true) reserveUserModeration(db, req.user.id)
    const workId = randomUUID()
    const versionId = randomUUID()
    const timestamp = now()
    transaction(db, () => {
      db.prepare(`INSERT INTO works(id,user_id,lesson,status,current_version_id,pending_version_id,is_demo,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(workId, req.user.id, lesson, publish ? 'pending' : 'draft', versionId, publish ? versionId : null, localDemo ? 1 : 0, timestamp, timestamp)
      insertVersion(db, { id: versionId, workId, nickname: req.user.nickname, input, decision: publish ? 'pending' : 'draft', timestamp })
    })
    if (publish) await moderateWork({ db, workId, versionId, input, user: req.user, moderator, mediaDir })
    const work = ownerWork(db, db.prepare('SELECT * FROM works WHERE id=?').get(workId), req.user.id)
    res.status(201).json({ work, message: workMessage(work, localDemo) })
  })

  app.put('/api/works/:id', requireUser, contentIpLimiter, contentUserLimiter, async (req, res) => {
    const work = db.prepare('SELECT * FROM works WHERE id=?').get(req.params.id)
    if (!work) throw httpError(404, '作品不存在', 'NOT_FOUND')
    if (work.user_id !== req.user.id && req.user.role !== 'admin') throw httpError(403, '无权编辑这件作品', 'FORBIDDEN')
    const input = validateWorkInput(req.body, { deploymentDomains, db, userId: work.user_id })
    const publish = req.body?.publish === true
    if (publish && req.body?.consent !== true) throw httpError(400, '发布前需明确同意公开展示', 'CONSENT_REQUIRED')
    if (publish && moderator.ready === true) reserveUserModeration(db, req.user.id)
    const versionId = randomUUID()
    const timestamp = now()
    transaction(db, () => {
      insertVersion(db, { id: versionId, workId: work.id, nickname: req.user.nickname, input, decision: publish ? 'pending' : 'draft', timestamp })
      let nextStatus = publish ? (work.approved_version_id ? work.status : 'pending') : (work.approved_version_id ? work.status : 'draft')
      if (work.status === 'hidden') nextStatus = 'hidden'
      db.prepare('UPDATE works SET current_version_id=?,pending_version_id=?,status=?,moderation_reason=NULL,updated_at=? WHERE id=?')
        .run(versionId, publish ? versionId : null, nextStatus, timestamp, work.id)
    })
    if (publish) await moderateWork({ db, workId: work.id, versionId, input, user: req.user, moderator, mediaDir })
    const result = ownerWork(db, db.prepare('SELECT * FROM works WHERE id=?').get(work.id), req.user.id)
    res.json({ work: result, message: workMessage(result, localDemo) })
  })

  app.post('/api/works/:id/hide', requireUser, (req, res) => {
    const work = db.prepare('SELECT * FROM works WHERE id=?').get(req.params.id)
    if (!work) throw httpError(404, '作品不存在', 'NOT_FOUND')
    if (work.user_id !== req.user.id && req.user.role !== 'admin') throw httpError(403, '无权隐藏这件作品', 'FORBIDDEN')
    db.prepare(`UPDATE works SET status='hidden',updated_at=? WHERE id=?`).run(now(), work.id)
    res.json({ ok: true })
  })

  app.post('/api/works/:id/like', requireUser, likeIpLimiter, likeUserLimiter, (req, res) => {
    if (typeof req.body?.liked !== 'boolean') throw httpError(400, '请提供 liked 布尔值', 'INVALID_LIKE')
    const work = db.prepare(`SELECT * FROM works WHERE id=? AND status='published' AND approved_version_id IS NOT NULL`).get(req.params.id)
    if (!work) throw httpError(404, '作品不存在或未公开', 'NOT_FOUND')
    if (work.user_id === req.user.id) throw httpError(400, '不能给自己的作品投票', 'SELF_LIKE')
    if (req.body.liked) db.prepare('INSERT OR IGNORE INTO likes(work_id,user_id,created_at) VALUES(?,?,?)').run(work.id, req.user.id, now())
    else db.prepare('DELETE FROM likes WHERE work_id=? AND user_id=?').run(work.id, req.user.id)
    const likes = Number(db.prepare('SELECT COUNT(*) count FROM likes WHERE work_id=?').get(work.id).count)
    res.json({ likes, liked: req.body.liked })
  })

  app.post('/api/works/:id/report', reportLimiter, (req, res) => {
    const reason = req.body?.reason
    if (!['link', 'content'].includes(reason)) throw httpError(400, '举报原因不正确', 'INVALID_REPORT')
    const detail = cleanText(req.body?.detail, 300)
    const work = db.prepare(`SELECT id FROM works WHERE id=? AND status='published'`).get(req.params.id)
    if (!work) throw httpError(404, '作品不存在或未公开', 'NOT_FOUND')
    const ipHash = createHash('sha256').update(`${phoneSecret}\0${req.ip}`).digest('hex')
    db.prepare('INSERT INTO reports(id,work_id,reason,detail,reporter_ip_hash,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), work.id, reason, detail, ipHash, now())
    res.json({ ok: true })
  })

  app.post('/api/uploads', requireUser, uploadIpLimiter, uploadUserLimiter, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: UPLOAD_LIMIT }), async (req, res) => {
    const mime = req.get('content-type')?.split(';')[0].toLowerCase()
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime) || !Buffer.isBuffer(req.body) || !req.body.length) throw httpError(415, '仅支持 PNG、JPEG 或 WebP 图片', 'INVALID_MEDIA_TYPE')
    const totals = db.prepare('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM uploads WHERE owner_id=?').get(req.user.id)
    if (Number(totals.count) >= UPLOAD_COUNT_LIMIT || Number(totals.bytes) >= UPLOAD_STORAGE_LIMIT) throw httpError(429, '每个账号最多保留 40 张、20MB 图片', 'UPLOAD_STORAGE_LIMIT')
    const unused = Number(db.prepare(`SELECT COUNT(*) count FROM uploads u WHERE u.owner_id=? AND NOT EXISTS(SELECT 1 FROM work_versions v WHERE v.cover_id=u.id) AND NOT EXISTS(SELECT 1 FROM users x WHERE x.avatar_id=u.id OR x.pending_avatar_id=u.id) AND NOT EXISTS(SELECT 1 FROM settings s WHERE s.official_qr_id=u.id OR s.group_qr_id=u.id)`).get(req.user.id).count)
    if (unused >= 10) throw httpError(429, '未使用图片过多，请先使用已上传图片', 'UPLOAD_QUOTA')
    if (activeImageJobs >= 3) throw httpError(429, '当前图片处理较多，请稍后再试', 'IMAGE_BUSY')
    activeImageJobs += 1
    try {
      let metadata
      try { metadata = await sharp(req.body, { limitInputPixels: 16_000_000 }).metadata() } catch { throw httpError(400, '图片无法解码', 'INVALID_IMAGE') }
      const expected = mime === 'image/jpeg' ? 'jpeg' : mime.slice(6)
      if (metadata.format !== expected || !metadata.width || !metadata.height || metadata.width * metadata.height > 16_000_000) throw httpError(400, '图片内容与类型不匹配或尺寸过大', 'INVALID_IMAGE')
      const id = randomUUID()
      const diskPath = join(mediaDir, `${id}.webp`)
      let output
      try { output = await sharp(req.body, { limitInputPixels: 16_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 86 }).toBuffer() } catch { throw httpError(400, '图片处理失败', 'INVALID_IMAGE') }
      const freshTotals = db.prepare('SELECT COUNT(*) count,COALESCE(SUM(bytes),0) bytes FROM uploads WHERE owner_id=?').get(req.user.id)
      if (Number(freshTotals.count) >= UPLOAD_COUNT_LIMIT || Number(freshTotals.bytes) + output.length > UPLOAD_STORAGE_LIMIT) throw httpError(429, '每个账号最多保留 40 张、20MB 图片', 'UPLOAD_STORAGE_LIMIT')
      writeFileSync(diskPath, output, { mode: 0o600, flag: 'wx' })
      db.prepare('INSERT INTO uploads(id,owner_id,disk_path,mime,bytes,created_at) VALUES(?,?,?,?,?,?)').run(id, req.user.id, diskPath, 'image/webp', output.length, now())
      res.status(201).json({ id })
    } finally {
      activeImageJobs -= 1
    }
  })

  app.get('/api/media/:id', (req, res) => {
    const upload = db.prepare('SELECT * FROM uploads WHERE id=?').get(req.params.id)
    if (!upload || !existsSync(upload.disk_path)) throw httpError(404, '图片不存在', 'NOT_FOUND')
    const privileged = req.user && (req.user.role === 'admin' || req.user.id === upload.owner_id)
    const publishedCover = db.prepare(`SELECT 1 FROM works w JOIN work_versions v ON v.id=w.approved_version_id WHERE w.status='published' AND v.cover_id=?`).get(upload.id)
    const setting = db.prepare('SELECT * FROM settings WHERE singleton=1').get()
    const activeGroup = setting.group_enabled && (!setting.group_expires_at || setting.group_expires_at > now())
    const visibleSetting = setting.official_qr_id === upload.id || (activeGroup && setting.group_qr_id === upload.id)
    if (!privileged && !publishedCover && !visibleSetting) throw httpError(404, '图片不存在', 'NOT_FOUND')
    // Recheck visibility on every reuse, so hidden works and expired QR codes
    // cannot remain available for an hour from a fresh public cache entry.
    res.setHeader('Cache-Control', privileged && !publishedCover && !visibleSetting ? 'private, no-store' : 'no-cache, must-revalidate')
    res.type(upload.mime).sendFile(resolve(upload.disk_path))
  })

  app.patch('/api/profile', requireUser, contentIpLimiter, contentUserLimiter, async (req, res) => {
    const nickname = validateNickname(req.body?.nickname)
    const hasAvatarId = Object.hasOwn(req.body || {}, 'avatarId')
    const avatarId = !hasAvatarId ? (req.user.avatar_id || null)
      : req.body.avatarId === null ? null
        : validateOwnedUpload(db, req.body.avatarId, req.user.id)
    const input = { title: '', description: '', url: '', coverId: avatarId }
    if (moderator.ready === true) reserveUserModeration(db, req.user.id)
    const revision = db.prepare(`UPDATE users
      SET profile_revision=profile_revision+1,pending_nickname=?,pending_avatar_id=?,profile_moderation_reason=?,updated_at=?
      WHERE id=? RETURNING profile_revision`).get(nickname, avatarId, '资料审核中', now(), req.user.id).profile_revision
    let result
    try { result = await moderateSnapshot({ input, nickname, moderator, db, mediaDir }) }
    catch { result = { decision: 'review', reason: '资料自动审核暂未完成' } }
    let applied
    if (result.decision === 'allow') {
      applied = db.prepare(`UPDATE users SET nickname=?,avatar_id=?,pending_nickname=NULL,pending_avatar_id=NULL,profile_moderation_reason=NULL,updated_at=? WHERE id=? AND profile_revision=?`).run(nickname, avatarId, now(), req.user.id, revision)
    } else if (result.decision === 'review') {
      applied = db.prepare(`UPDATE users SET profile_moderation_reason=?,updated_at=? WHERE id=? AND profile_revision=?`).run(safeReason(result.reason), now(), req.user.id, revision)
    } else {
      applied = db.prepare(`UPDATE users SET pending_nickname=NULL,pending_avatar_id=NULL,profile_moderation_reason=?,updated_at=? WHERE id=? AND profile_revision=?`).run(safeReason(result.reason), now(), req.user.id, revision)
    }
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id)
    const stale = Number(applied.changes) === 0
    const message = stale ? '较新的个人资料变更已提交，本次较旧结果已忽略'
      : result.decision === 'allow' ? (localDemo ? LOCAL_DEMO_MESSAGE : '个人资料已更新') : (result.reason || '个人资料暂未更新')
    res.json({ user: privateUser(user), message })
  })

  app.get('/api/settings', (_req, res) => res.json({ settings: publicSettings(db) }))

  app.get('/api/admin/overview', requireAdmin, (_req, res) => {
    const stats = {
      users: Number(db.prepare('SELECT COUNT(*) count FROM users').get().count),
      works: Number(db.prepare('SELECT COUNT(*) count FROM works').get().count),
      pending: Number(db.prepare('SELECT COUNT(*) count FROM works WHERE pending_version_id IS NOT NULL').get().count),
      reports: Number(db.prepare('SELECT COUNT(*) count FROM reports').get().count)
    }
    const works = db.prepare('SELECT * FROM works ORDER BY updated_at DESC LIMIT 100').all().map((row) => ownerWork(db, row, null))
    const reports = db.prepare(`SELECT r.id,r.work_id AS workId,r.reason,r.detail,r.created_at AS createdAt FROM reports r ORDER BY r.created_at DESC LIMIT 100`).all()
    res.json({ stats, works, reports, settings: adminSettings(db), moderationReady: moderator.ready === true, mode })
  })

  app.put('/api/admin/settings', requireAdmin, (req, res) => {
    const current = db.prepare('SELECT * FROM settings WHERE singleton=1').get()
    const officialAccountName = cleanText(req.body?.officialAccountName ?? current.official_account_name, 80)
    const groupName = cleanText(req.body?.groupName ?? current.group_name, 80)
    const announcement = cleanText(req.body?.announcement ?? current.announcement, 500)
    const officialQrId = nullableAdminUpload(db, req.body?.officialQrId, current.official_qr_id, req.user.id)
    const groupQrId = nullableAdminUpload(db, req.body?.groupQrId, current.group_qr_id, req.user.id)
    const groupExpiresAt = nullableDate(req.body?.groupExpiresAt ?? current.group_expires_at)
    const groupEnabled = req.body?.groupEnabled === undefined ? Boolean(current.group_enabled) : req.body.groupEnabled === true
    db.prepare(`UPDATE settings SET official_account_name=?,official_qr_id=?,group_name=?,group_qr_id=?,group_expires_at=?,group_enabled=?,announcement=?,updated_at=? WHERE singleton=1`)
      .run(officialAccountName, officialQrId, groupName, groupQrId, groupExpiresAt, groupEnabled ? 1 : 0, announcement, now())
    res.json({ settings: adminSettings(db) })
  })

  app.post('/api/admin/works/:id/review', requireAdmin, (req, res) => {
    const action = req.body?.action
    if (!['approve', 'hide'].includes(action)) throw httpError(400, '审核动作不正确', 'INVALID_ACTION')
    const work = db.prepare('SELECT * FROM works WHERE id=?').get(req.params.id)
    if (!work) throw httpError(404, '作品不存在', 'NOT_FOUND')
    if (action === 'hide') {
      db.prepare(`UPDATE works SET status='hidden',pending_version_id=NULL,moderation_reason='管理员已隐藏',updated_at=? WHERE id=?`).run(now(), work.id)
    } else {
      const target = work.current_version_id
      if (!target) throw httpError(409, '没有可审核版本', 'NO_REVIEW_TARGET')
      const targetVersion = db.prepare('SELECT decision FROM work_versions WHERE id=?').get(target)
      if (!targetVersion || targetVersion.decision === 'draft') throw httpError(409, '草稿不是可审核版本', 'NO_REVIEW_TARGET')
      transaction(db, () => {
        db.prepare(`UPDATE work_versions SET decision='allow',moderation_reason='管理员手工通过' WHERE id=?`).run(target)
        db.prepare(`UPDATE works SET approved_version_id=?,pending_version_id=NULL,status='published',moderation_reason='管理员手工通过',updated_at=? WHERE id=?`).run(target, now(), work.id)
      })
    }
    res.json({ ok: true })
  })

  const distDir = options.distDir || join(process.cwd(), 'dist')
  if (existsSync(join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false }))
    app.get('/{*path}', (req, res, next) => (req.path === '/api' || req.path.startsWith('/api/')) ? next() : res.sendFile(resolve(distDir, 'index.html')))
  }

  app.use('/api', (_req, _res, next) => next(httpError(404, '接口不存在', 'NOT_FOUND')))
  app.use((error, _req, res, _next) => {
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500)
    const message = status === 500 ? '服务器内部错误' : error.message
    if (status === 500 && !options.silentErrors) console.error(error)
    res.status(status).json({ error: message, ...(error.code ? { code: error.code } : {}) })
  })
  return app
}

function limiter(limit, windowMs, keyGenerator) {
  return rateLimit({
    windowMs, limit, standardHeaders: true, legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (_req, res) => res.status(429).json({ error: '请求过于频繁，请稍后再试', code: 'RATE_LIMITED' })
  })
}

function loginFailureKey(username) {
  return createHash('sha256').update(normalizeUsername(username).toLowerCase()).digest('hex')
}

function loginFailureBlocked(db, username) {
  return Boolean(db.prepare('SELECT 1 FROM login_failures WHERE username_key=? AND window_started_at>=? AND failures>=10')
    .get(loginFailureKey(username), Date.now() - 15 * 60 * 1000))
}

function recordLoginFailure(db, username) {
  const timestamp = Date.now()
  return Number(db.prepare(`INSERT INTO login_failures(username_key,window_started_at,failures) VALUES(?,?,1)
    ON CONFLICT(username_key) DO UPDATE SET
      failures=CASE WHEN login_failures.window_started_at<? THEN 1 ELSE login_failures.failures+1 END,
      window_started_at=CASE WHEN login_failures.window_started_at<? THEN excluded.window_started_at ELSE login_failures.window_started_at END
    RETURNING failures`).get(loginFailureKey(username), timestamp, timestamp - 15 * 60 * 1000, timestamp - 15 * 60 * 1000).failures)
}

function clearLoginFailures(db, username) {
  db.prepare('DELETE FROM login_failures WHERE username_key=?').run(loginFailureKey(username))
}

function reserveUserModeration(db, userId) {
  const day = new Date().toISOString().slice(0, 10)
  db.prepare('INSERT OR IGNORE INTO moderation_user_usage(day,user_id,requests) VALUES(?,?,0)').run(day, userId)
  const reservation = db.prepare('UPDATE moderation_user_usage SET requests=requests+1 WHERE day=? AND user_id=? AND requests<50 RETURNING requests').get(day, userId)
  if (!reservation) throw httpError(429, '今日自动审核次数已达上限，请明天再试', 'MODERATION_DAILY_LIMIT')
}

function requireUser(req, _res, next) {
  if (!req.user) return next(httpError(401, '请先登录', 'AUTH_REQUIRED'))
  next()
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(httpError(401, '请先登录', 'AUTH_REQUIRED'))
  if (req.user.role !== 'admin') return next(httpError(403, '需要管理员权限', 'ADMIN_REQUIRED'))
  next()
}

function validateNickname(value) {
  const nickname = cleanText(value, 30)
  if (!nickname || nickname.length < 2) throw httpError(400, '昵称需为 2–30 个字符', 'INVALID_NICKNAME')
  return nickname
}

function cleanText(value, max) {
  const text = String(value ?? '').normalize('NFKC').trim()
  if (text.length > max) throw httpError(400, `文字不能超过 ${max} 个字符`, 'TEXT_TOO_LONG')
  return text
}

function validateWorkInput(body, { deploymentDomains, db, userId }) {
  const title = cleanText(body?.title, 80)
  const description = cleanText(body?.description, 500)
  const url = validateDeploymentUrl(body?.url, deploymentDomains)
  const coverId = body?.coverId === null || body?.coverId === undefined || body?.coverId === '' ? null : validateOwnedUpload(db, body.coverId, userId)
  const combined = `${title}\n${description}`
  if ((combined.match(/https?:\/\//gi) || []).length > 3 || /(.)\1{19}/u.test(combined)) throw httpError(400, '内容疑似垃圾信息，请简化后重试', 'SPAM_DETECTED')
  return { title, description, url, coverId }
}

function validateDeploymentUrl(value, domains) {
  let parsed
  try { parsed = new URL(String(value || '')) } catch { throw httpError(400, '请填写有效的作品链接', 'INVALID_URL') }
  const host = parsed.hostname.toLowerCase()
  if (parsed.href.length > 2048 || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || isIP(host) || host === 'localhost' || host.endsWith('.local')) throw httpError(400, '作品链接必须是安全的允许域名', 'INVALID_URL')
  const allowed = domains.some((entry) => entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host !== entry.slice(2) : host === entry)
  if (!allowed) throw httpError(400, '作品链接不在允许的部署域名中', 'URL_NOT_ALLOWED')
  parsed.hash = ''
  return parsed.toString()
}

function validateOwnedUpload(db, id, ownerId) {
  const upload = db.prepare('SELECT id FROM uploads WHERE id=? AND owner_id=?').get(String(id), ownerId)
  if (!upload) throw httpError(400, '图片不存在或不属于当前用户', 'INVALID_UPLOAD')
  return upload.id
}

function nullableAdminUpload(db, supplied, current, adminId) {
  if (supplied === undefined) return current
  if (supplied === null || supplied === '') return null
  return validateOwnedUpload(db, supplied, adminId)
}

function nullableDate(value) {
  if (value === null || value === '') return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw httpError(400, '群二维码到期时间不正确', 'INVALID_DATE')
  return date.toISOString()
}

function requiredLesson(value) {
  const lesson = Number(value)
  if (!Number.isInteger(lesson) || lesson < 1 || lesson > 3) throw httpError(400, '讲次必须是 1、2 或 3', 'INVALID_LESSON')
  return lesson
}

function optionalLesson(value) { return value === undefined || value === '' ? null : requiredLesson(value) }
function positiveInt(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : fallback }
function positiveEnvNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback }
function escapeLike(value) { return value.replace(/[\\%_]/g, '\\$&') }
function now() { return new Date().toISOString() }

function insertVersion(db, { id, workId, nickname, input, decision, timestamp }) {
  db.prepare(`INSERT INTO work_versions(id,work_id,nickname,title,description,url,cover_id,decision,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, workId, nickname, input.title, input.description, input.url, input.coverId, decision, timestamp)
}

async function moderateSnapshot({ input, nickname, moderator, db, mediaDir }) {
  let image = null
  if (input.coverId) {
    const upload = db.prepare('SELECT * FROM uploads WHERE id=?').get(input.coverId)
    if (upload && upload.disk_path.startsWith(mediaDir + sep)) image = { mime: upload.mime, data: readFileSync(upload.disk_path).toString('base64') }
  }
  return moderator.moderate({
    content: { nickname, title: input.title, description: input.description, url: input.url },
    image,
    policy: { externalHomepage: false }
  })
}

// Operator-only retry entry point: no public endpoint and no manual approval.
export async function recheckPendingWork(app, workId, expectedVersionId) {
  const db = app.locals.db
  const { moderator, mediaDir, deploymentDomains, mode } = app.locals.config
  if (mode !== 'live' || !moderator.ready) throw new Error('真实审核服务尚未就绪')
  const work = db.prepare('SELECT * FROM works WHERE id=?').get(workId)
  if (!work || work.status !== 'pending' || work.current_version_id !== expectedVersionId || work.pending_version_id !== expectedVersionId) throw new Error('作品已变化或不再待审，停止重试')
  const version = db.prepare('SELECT * FROM work_versions WHERE id=? AND work_id=?').get(expectedVersionId, workId)
  if (!version || version.decision !== 'review') throw new Error('只重试已结束但未能确定的审核')
  const input = validateWorkInput({ ...version, coverId: version.cover_id }, { deploymentDomains, db, userId: work.user_id })
  reserveUserModeration(db, work.user_id)
  await moderateWork({ db, workId, versionId: expectedVersionId, input, user: { nickname: version.nickname }, moderator, mediaDir })
  const latest = db.prepare('SELECT status,moderation_reason FROM works WHERE id=?').get(workId)
  return { workId, status: latest.status, reason: latest.moderation_reason }
}

async function moderateWork({ db, workId, versionId, input, user, moderator, mediaDir }) {
  let result
  try { result = await moderateSnapshot({ input, nickname: user.nickname, moderator, db, mediaDir }) }
  catch { result = { decision: 'review', reason: '自动审核服务暂时不可用，已转为待审' } }
  if (!['allow', 'reject', 'review'].includes(result?.decision)) result = { decision: 'review', reason: '自动审核结果无效，已转为待审' }
  const reason = safeReason(result.reason)
  transaction(db, () => {
    db.prepare('UPDATE work_versions SET decision=?,moderation_reason=? WHERE id=?').run(result.decision, reason, versionId)
    const latest = db.prepare('SELECT * FROM works WHERE id=?').get(workId)
    if (!latest || latest.current_version_id !== versionId) return
    if (result.decision === 'allow') {
      const status = latest.status === 'hidden' ? 'hidden' : 'published'
      db.prepare('UPDATE works SET approved_version_id=?,pending_version_id=NULL,status=?,moderation_reason=?,updated_at=? WHERE id=?').run(versionId, status, reason, now(), workId)
    } else if (result.decision === 'reject') {
      const status = latest.status === 'hidden' ? 'hidden' : (latest.approved_version_id ? 'published' : 'rejected')
      db.prepare('UPDATE works SET pending_version_id=NULL,status=?,moderation_reason=?,updated_at=? WHERE id=?').run(status, reason || '自动审核未通过', now(), workId)
    } else {
      const status = latest.status === 'hidden' ? 'hidden' : (latest.approved_version_id ? 'published' : 'pending')
      db.prepare('UPDATE works SET pending_version_id=?,status=?,moderation_reason=?,updated_at=? WHERE id=?').run(versionId, status, reason || UNCONFIGURED_MESSAGE, now(), workId)
    }
  })
}

function publicWorkSql(viewerId) {
  const sql = `SELECT w.*,v.title,v.description,v.url,v.cover_id,u.nickname,
    (SELECT COUNT(*) FROM likes l WHERE l.work_id=w.id) likes_count,
    ${viewerId ? '(SELECT COUNT(*) FROM likes ml WHERE ml.work_id=w.id AND ml.user_id=?)' : '0'} liked_count
    FROM works w JOIN work_versions v ON v.id=w.approved_version_id JOIN users u ON u.id=w.user_id`
  return { sql, params: viewerId ? [viewerId] : [] }
}

function publicWork(row, version = row) {
  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    lesson: row.lesson,
    title: version.title,
    description: version.description,
    url: version.url,
    coverId: version.cover_id || null,
    status: row.status,
    likes: Number(row.likes_count || 0),
    liked: Boolean(row.liked_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDemo: Boolean(row.is_demo)
  }
}

function ownerWork(db, row, viewerId) {
  const approved = row.approved_version_id ? db.prepare('SELECT * FROM work_versions WHERE id=?').get(row.approved_version_id) : null
  const current = db.prepare('SELECT * FROM work_versions WHERE id=?').get(row.current_version_id)
  const user = db.prepare('SELECT nickname FROM users WHERE id=?').get(row.user_id)
  const likes = Number(db.prepare('SELECT COUNT(*) count FROM likes WHERE work_id=?').get(row.id).count)
  const liked = viewerId ? Boolean(db.prepare('SELECT 1 FROM likes WHERE work_id=? AND user_id=?').get(row.id, viewerId)) : false
  const baseVersion = approved || current
  const base = publicWork({ ...row, nickname: user.nickname, likes_count: likes, liked_count: liked ? 1 : 0 }, baseVersion)
  const candidate = current && current.id !== row.approved_version_id ? current : null
  return {
    ...base,
    pendingVersion: candidate ? {
      title: candidate.title, description: candidate.description, url: candidate.url,
      coverId: candidate.cover_id || null, status: candidate.decision
    } : null,
    moderationReason: row.moderation_reason || candidate?.moderation_reason || null
  }
}

function workMessage(work, localDemo) {
  if (localDemo && work.status === 'published') return LOCAL_DEMO_MESSAGE
  if (work.pendingVersion?.status === 'review' || work.status === 'pending') return work.moderationReason || UNCONFIGURED_MESSAGE
  if (work.pendingVersion?.status === 'reject' || work.status === 'rejected') return work.moderationReason || '作品未通过审核'
  if (work.status === 'draft') return '草稿已保存，尚未公开'
  if (work.status === 'hidden') return '作品保持隐藏'
  return '作品已公开'
}

function safeReason(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim().slice(0, 300) : ''
}

function publicSettings(db) {
  const row = db.prepare('SELECT * FROM settings WHERE singleton=1').get()
  const activeGroup = Boolean(row.group_enabled) && (!row.group_expires_at || row.group_expires_at > now())
  return {
    officialAccountName: row.official_account_name,
    officialQrId: row.official_qr_id || null,
    groupName: row.group_name,
    groupQrId: activeGroup ? (row.group_qr_id || null) : null,
    groupExpiresAt: row.group_expires_at || null,
    groupEnabled: activeGroup,
    announcement: row.announcement
  }
}

function adminSettings(db) {
  const row = db.prepare('SELECT * FROM settings WHERE singleton=1').get()
  return {
    officialAccountName: row.official_account_name,
    officialQrId: row.official_qr_id || null,
    groupName: row.group_name,
    groupQrId: row.group_qr_id || null,
    groupExpiresAt: row.group_expires_at || null,
    groupEnabled: Boolean(row.group_enabled),
    announcement: row.announcement
  }
}
