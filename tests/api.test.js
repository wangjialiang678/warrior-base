import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { createApp, recheckPendingWork } from '../server/app.js'
import { insertUser } from '../server/auth.js'
import { openDatabase } from '../server/db.js'

const ORIGIN = 'http://warrior.test'

async function fixture(options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'warrior-api-'))
  const app = createApp({ dataDir, appOrigin: ORIGIN, host: '127.0.0.1', silentErrors: true, ...options })
  const server = await new Promise((resolve) => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  async function close() {
    await new Promise((resolve) => server.close(resolve))
    app.locals.db.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
  return { app, base, close }
}

function client(base) {
  let cookie = ''
  return {
    get cookie() { return cookie },
    set cookie(value) { cookie = value },
    async request(path, { method = 'GET', body, headers = {}, origin = method !== 'GET' } = {}) {
      const finalHeaders = { ...headers }
      if (cookie) finalHeaders.cookie = cookie
      if (origin) finalHeaders.origin = ORIGIN
      let payload = body
      if (body !== undefined && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        finalHeaders['content-type'] = 'application/json'
        payload = JSON.stringify(body)
      }
      const response = await fetch(`${base}${path}`, { method, headers: finalHeaders, body: payload })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const type = response.headers.get('content-type') || ''
      const data = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer())
      return { response, data }
    }
  }
}

async function register(api, suffix = 'one') {
  const result = await api.request('/api/auth/register', {
    method: 'POST',
    body: { username: `user_${suffix}`, password: 'correct-horse-1', nickname: `勇士${suffix}`, phone: `1380000${String(suffix.length).padStart(4, '0')}`, remember: true }
  })
  assert.equal(result.response.status, 201)
  return result.data.user
}

const allowModerator = {
  ready: true,
  async moderate() { return { decision: 'allow', reason: '通过' } }
}

test('server blocks local and unsupported links before creating a work or invoking AI', async (t) => {
  let moderationCalls = 0
  const fx = await fixture({ moderator: { ready: true, async moderate() { moderationCalls++; return { decision: 'allow', reason: '通过' } } } })
  t.after(fx.close)
  const api = client(fx.base)
  await register(api, 'links')
  moderationCalls = 0
  for (const url of ['http://127.0.0.1:5173', 'https://127.0.0.1', 'localhost:3000', 'https://localhost', 'https://192.168.1.5', 'https://[::1]', 'file:///tmp/work.html', 'http://workbuddy.link/p/test', 'https://workbuddy.link.evil.example/p/x', 'https://example.com']) {
    const result = await api.request('/api/works', { method: 'POST', body: { lesson: 1, title: '测试作品', url, publish: true, consent: true } })
    assert.equal(result.response.status, 400, url)
    assert.ok(['INVALID_URL', 'URL_NOT_ALLOWED'].includes(result.data.code), url)
  }
  assert.equal(moderationCalls, 0)
  assert.equal(fx.app.locals.db.prepare('SELECT COUNT(*) AS n FROM works').get().n, 0)
})

test('existing databases gain profile_revision without losing user rows', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'warrior-migrate-'))
  try {
    const filename = 'existing.sqlite'
    const legacy = new DatabaseSync(join(dataDir, filename))
    legacy.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, nickname TEXT NOT NULL,
      phone_hash TEXT, phone_last4 TEXT, role TEXT NOT NULL DEFAULT 'user', avatar_id TEXT,
      pending_nickname TEXT, pending_avatar_id TEXT, profile_moderation_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`)
    legacy.prepare(`INSERT INTO users(id,username,password_hash,password_salt,nickname,created_at,updated_at)
      VALUES('legacy','legacy_user','hash','salt','旧用户','2020-01-01','2020-01-01')`).run()
    legacy.close()
    const migrated = openDatabase(dataDir, filename)
    const row = migrated.prepare('SELECT id,nickname,profile_revision FROM users WHERE id=?').get('legacy')
    assert.equal(row.id, 'legacy')
    assert.equal(row.nickname, '旧用户')
    assert.equal(row.profile_revision, 0)
    migrated.close()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('local demo: exact Origin, persistent login, publish, ownership and votes', async (t) => {
  const fx = await fixture({ localDemo: true })
  t.after(fx.close)
  const owner = client(fx.base)
  const voter = client(fx.base)

  const health = await owner.request('/api/health')
  assert.deepEqual(health.data, { ok: true, mode: 'local-demo', moderationReady: false })
  const denied = await owner.request('/api/auth/register', {
    method: 'POST', origin: false,
    body: { username: 'blocked', password: 'correct-horse-1', nickname: '被拒绝', phone: '13800000000' }
  })
  assert.equal(denied.response.status, 403)
  assert.equal(denied.data.code, 'BAD_ORIGIN')

  const user = await register(owner, 'owner')
  assert.match(owner.cookie, /^warrior_session=/)
  const me = await owner.request('/api/me')
  assert.equal(me.data.user.id, user.id)
  assert.equal(me.data.user.phoneMasked.endsWith('0005'), true)

  const made = await owner.request('/api/works', {
    method: 'POST',
    body: { lesson: 1, title: '我的冒险主页', description: '第一件作品', url: 'https://workbuddy.link/p/demo', publish: true, consent: true }
  })
  assert.equal(made.response.status, 201)
  assert.equal(made.data.work.status, 'published')
  assert.match(made.data.message, /本机演示/)
  const workId = made.data.work.id

  const conflict = await owner.request('/api/works', {
    method: 'POST',
    body: { lesson: 1, url: 'https://workbuddy.link/p/again', publish: false }
  })
  assert.equal(conflict.response.status, 409)
  const selfLike = await owner.request(`/api/works/${workId}/like`, { method: 'POST', body: { liked: true } })
  assert.equal(selfLike.response.status, 400)
  assert.equal(selfLike.data.code, 'SELF_LIKE')

  await register(voter, 'voter')
  const liked = await voter.request(`/api/works/${workId}/like`, { method: 'POST', body: { liked: true } })
  assert.deepEqual(liked.data, { likes: 1, liked: true })
  const likedAgain = await voter.request(`/api/works/${workId}/like`, { method: 'POST', body: { liked: true } })
  assert.deepEqual(likedAgain.data, { likes: 1, liked: true })
  const gallery = await voter.request('/api/works?lesson=1&page=1')
  assert.equal(gallery.data.total, 1)
  assert.equal(gallery.data.works[0].liked, true)
  assert.equal(gallery.data.works[0].nickname, '勇士owner')
  assert.equal(gallery.data.works[0].title, '我的冒险主页')
  assert.equal(gallery.data.works[0].description, '第一件作品')
  assert.equal(gallery.data.works[0].url, 'https://workbuddy.link/p/demo')
  assert.equal(gallery.data.works[0].coverId, null)
  assert.equal('phone' in gallery.data.works[0], false)
  const profile = await voter.request(`/api/profiles/${user.id}`)
  assert.equal(profile.data.works[0].title, '我的冒险主页')
  assert.equal(profile.data.works[0].url, 'https://workbuddy.link/p/demo')
  assert.equal(profile.data.works[0].coverId, null)
})

test('live fail-closed and approved-version isolation across a pending edit', async (t) => {
  let calls = 0
  const moderator = {
    ready: true,
    async moderate() {
      calls += 1
      return calls <= 2 ? { decision: 'allow', reason: '通过' } : { decision: 'review', reason: '需人工复核' }
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  await register(api, 'author')
  const created = await api.request('/api/works', {
    method: 'POST', body: { lesson: 2, title: '旧标题', description: '已通过', url: 'https://www.workbuddy.link/p/old', publish: true, consent: true }
  })
  assert.equal(created.data.work.status, 'published')
  const id = created.data.work.id
  const edited = await api.request(`/api/works/${id}`, {
    method: 'PUT', body: { title: '新标题', description: '待审中', url: 'https://workbuddy.link/p/new', publish: true, consent: true }
  })
  assert.equal(edited.data.work.status, 'published')
  assert.equal(edited.data.work.title, '旧标题')
  assert.equal(edited.data.work.pendingVersion.title, '新标题')
  assert.equal(edited.data.work.pendingVersion.status, 'review')
  const publicView = await client(fx.base).request(`/api/works/${id}`)
  assert.equal(publicView.data.work.title, '旧标题')
  assert.equal(publicView.data.work.coverId, null)

  const closedFx = await fixture({ moderator: undefined })
  t.after(closedFx.close)
  const closed = client(closedFx.base)
  await register(closed, 'closed')
  const pending = await closed.request('/api/works', {
    method: 'POST', body: { lesson: 1, url: 'https://workbuddy.link/p/closed', publish: true, consent: true }
  })
  assert.equal(pending.data.work.status, 'pending')
  assert.match(pending.data.message, /审核尚未配置/)
  const invisible = await client(closedFx.base).request(`/api/works/${pending.data.work.id}`)
  assert.equal(invisible.response.status, 404)
})

test('operator recheck publishes the same pending review without inspecting its external page', async (t) => {
  let workCalls = 0
  const snapshots = []
  const moderator = {
    ready: true,
    async moderate(snapshot) {
      snapshots.push(snapshot)
      if (!snapshot.content.url) return { decision: 'allow', reason: '昵称通过' }
      workCalls += 1
      return workCalls === 1
        ? { decision: 'review', reason: '旧规则未能确定' }
        : { decision: 'allow', reason: '本站内容通过' }
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  const user = await register(api, 'recheck')
  const created = await api.request('/api/works', {
    method: 'POST', body: { lesson: 3, title: '示例作品', description: '记录收支', url: 'https://workbuddy.link/p/recheck', publish: true, consent: true }
  })
  assert.equal(created.data.work.status, 'pending')
  const row = fx.app.locals.db.prepare('SELECT current_version_id FROM works WHERE id=?').get(created.data.work.id)

  const result = await recheckPendingWork(fx.app, created.data.work.id, row.current_version_id)

  assert.deepEqual(result, { workId: created.data.work.id, status: 'published', reason: '本站内容通过' })
  const stored = fx.app.locals.db.prepare('SELECT status,approved_version_id,pending_version_id FROM works WHERE id=?').get(created.data.work.id)
  assert.equal(stored.status, 'published')
  assert.equal(stored.approved_version_id, row.current_version_id)
  assert.equal(stored.pending_version_id, null)
  assert.equal(fx.app.locals.db.prepare('SELECT decision FROM work_versions WHERE id=?').get(row.current_version_id).decision, 'allow')
  assert.equal(snapshots.at(-1).policy.externalHomepage, false)
  assert.equal(snapshots.at(-1).content.url, 'https://workbuddy.link/p/recheck')
  const usage = fx.app.locals.db.prepare('SELECT requests FROM moderation_user_usage WHERE day=? AND user_id=?').get(new Date().toISOString().slice(0, 10), user.id)
  assert.equal(usage.requests, 2)
})

test('operator recheck rejects a wrong version and non-pending work states', async (t) => {
  const moderator = {
    ready: true,
    async moderate(snapshot) {
      return snapshot.content.url
        ? { decision: 'review', reason: '待重审' }
        : { decision: 'allow', reason: '昵称通过' }
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  await register(api, 'recheckguards')
  const created = await api.request('/api/works', {
    method: 'POST', body: { lesson: 2, title: '待重审作品', url: 'https://workbuddy.link/p/guards', publish: true, consent: true }
  })
  const id = created.data.work.id
  const db = fx.app.locals.db
  const versionId = db.prepare('SELECT current_version_id FROM works WHERE id=?').get(id).current_version_id

  await assert.rejects(recheckPendingWork(fx.app, id, 'wrong-version'), /作品已变化或不再待审/)
  for (const status of ['draft', 'hidden', 'published']) {
    db.prepare('UPDATE works SET status=? WHERE id=?').run(status, id)
    await assert.rejects(recheckPendingWork(fx.app, id, versionId), /作品已变化或不再待审/, status)
  }
})

test('unreviewed registration nickname never leaks publicly; approved rename stays consistent', async (t) => {
  let decision = 'review'
  const moderator = {
    ready: true,
    async moderate() { return decision === 'review' ? { decision: 'review', reason: '待审' } : { decision: 'allow', reason: '通过' } }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  const registered = await register(api, 'nickname')
  assert.notEqual(registered.nickname, '勇士nickname')
  const absentProfile = await client(fx.base).request(`/api/profiles/${registered.id}`)
  assert.equal(absentProfile.response.status, 404)

  decision = 'allow'
  const made = await api.request('/api/works', {
    method: 'POST', body: { lesson: 1, title: '作品', url: 'https://workbuddy.link/p/nickname', publish: true, consent: true }
  })
  const publicBefore = await client(fx.base).request(`/api/works/${made.data.work.id}`)
  assert.equal(publicBefore.data.work.nickname, registered.nickname)
  assert.notEqual(publicBefore.data.work.nickname, '勇士nickname')

  const renamed = await api.request('/api/profile', { method: 'PATCH', body: { nickname: '已审核新名' } })
  assert.equal(renamed.data.user.nickname, '已审核新名')
  const publicAfter = await client(fx.base).request(`/api/works/${made.data.work.id}`)
  const profileAfter = await client(fx.base).request(`/api/profiles/${registered.id}`)
  assert.equal(publicAfter.data.work.nickname, '已审核新名')
  assert.equal(profileAfter.data.profile.nickname, '已审核新名')
})

test('a late profile allow cannot overwrite a newer approved nickname or avatar', async (t) => {
  let resolveOld
  const moderator = {
    ready: true,
    async moderate(snapshot) {
      if (snapshot.content.nickname === '较旧资料') return new Promise((resolve) => { resolveOld = resolve })
      return { decision: 'allow', reason: '通过' }
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  const user = await register(api, 'raceallow')
  const firstImage = await uploadTestImage(api, '#112233')
  const secondImage = await uploadTestImage(api, '#445566')

  const oldRequest = api.request('/api/profile', { method: 'PATCH', body: { nickname: '较旧资料', avatarId: firstImage } })
  while (!resolveOld) await new Promise((resolve) => setTimeout(resolve, 1))
  const newer = await api.request('/api/profile', { method: 'PATCH', body: { nickname: '较新资料', avatarId: secondImage } })
  assert.equal(newer.data.user.nickname, '较新资料')
  resolveOld({ decision: 'allow', reason: '迟到通过' })
  const older = await oldRequest
  assert.match(older.data.message, /较旧结果已忽略/)

  const stored = fx.app.locals.db.prepare('SELECT nickname,avatar_id,pending_nickname,pending_avatar_id,profile_revision FROM users WHERE id=?').get(user.id)
  assert.equal(stored.nickname, '较新资料')
  assert.equal(stored.avatar_id, secondImage)
  assert.equal(stored.pending_nickname, null)
  assert.equal(stored.pending_avatar_id, null)
  assert.equal(stored.profile_revision, 2)
})

test('a late profile rejection cannot clear a newer approved nickname or avatar', async (t) => {
  let resolveOld
  const moderator = {
    ready: true,
    async moderate(snapshot) {
      if (snapshot.content.nickname === '会迟到被拒') return new Promise((resolve) => { resolveOld = resolve })
      return { decision: 'allow', reason: '通过' }
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  const user = await register(api, 'racereject')
  const firstImage = await uploadTestImage(api, '#778899')
  const secondImage = await uploadTestImage(api, '#aabbcc')

  const oldRequest = api.request('/api/profile', { method: 'PATCH', body: { nickname: '会迟到被拒', avatarId: firstImage } })
  while (!resolveOld) await new Promise((resolve) => setTimeout(resolve, 1))
  await api.request('/api/profile', { method: 'PATCH', body: { nickname: '已通过资料', avatarId: secondImage } })
  resolveOld({ decision: 'reject', reason: '迟到拒绝' })
  const older = await oldRequest
  assert.match(older.data.message, /较旧结果已忽略/)

  const stored = fx.app.locals.db.prepare('SELECT nickname,avatar_id,pending_nickname,pending_avatar_id,profile_moderation_reason,profile_revision FROM users WHERE id=?').get(user.id)
  assert.equal(stored.nickname, '已通过资料')
  assert.equal(stored.avatar_id, secondImage)
  assert.equal(stored.pending_nickname, null)
  assert.equal(stored.pending_avatar_id, null)
  assert.equal(stored.profile_moderation_reason, null)
  assert.equal(stored.profile_revision, 2)
})

test('omitting avatarId during a nickname edit preserves the approved avatar', async (t) => {
  const fx = await fixture({ moderator: allowModerator })
  t.after(fx.close)
  const api = client(fx.base)
  const user = await register(api, 'keepavatar')
  const avatarId = await uploadTestImage(api, '#224466')
  const withAvatar = await api.request('/api/profile', { method: 'PATCH', body: { nickname: '有头像勇士', avatarId } })
  assert.equal(withAvatar.response.status, 200)
  const nicknameOnly = await api.request('/api/profile', { method: 'PATCH', body: { nickname: '改名保留头像' } })
  assert.equal(nicknameOnly.response.status, 200)
  const stored = fx.app.locals.db.prepare('SELECT nickname,avatar_id FROM users WHERE id=?').get(user.id)
  assert.equal(stored.nickname, '改名保留头像')
  assert.equal(stored.avatar_id, avatarId)
})

test('late moderation cannot republish a hidden work', async (t) => {
  let resolveSecond
  let call = 0
  const moderator = {
    ready: true,
    moderate(snapshot) {
      call += 1
      if (!snapshot.content.url || snapshot.content.url.endsWith('/a')) return Promise.resolve({ decision: 'allow', reason: '通过' })
      return new Promise((resolve) => { resolveSecond = resolve })
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  await register(api, 'late')
  const made = await api.request('/api/works', {
    method: 'POST', body: { lesson: 3, title: '原版', url: 'https://workbuddy.link/p/a', publish: true, consent: true }
  })
  const id = made.data.work.id
  const editPromise = api.request(`/api/works/${id}`, {
    method: 'PUT', body: { title: '迟到版', url: 'https://workbuddy.link/p/b', publish: true, consent: true }
  })
  while (!resolveSecond) await new Promise((resolve) => setTimeout(resolve, 1))
  const hidden = await api.request(`/api/works/${id}/hide`, { method: 'POST', body: {} })
  assert.equal(hidden.response.status, 200)
  resolveSecond({ decision: 'allow', reason: '迟到通过' })
  const edited = await editPromise
  assert.equal(edited.data.work.status, 'hidden')
  const publicView = await client(fx.base).request(`/api/works/${id}`)
  assert.equal(publicView.response.status, 404)
})

test('phone recovery revokes every session and never permits admin recovery', async (t) => {
  const fx = await fixture({ moderator: allowModerator, phoneSecret: 'test-secret' })
  t.after(fx.close)
  const first = client(fx.base)
  await register(first, 'recover')
  const second = client(fx.base)
  const login = await second.request('/api/auth/login', { method: 'POST', body: { username: 'user_recover', password: 'correct-horse-1', remember: true } })
  assert.equal(login.response.status, 200)
  const recovery = await client(fx.base).request('/api/auth/recover', {
    method: 'POST', body: { username: 'user_recover', phone: '13800000007', newPassword: 'new-correct-horse' }
  })
  assert.equal(recovery.response.status, 200)
  assert.equal((await first.request('/api/me')).data.user, null)
  assert.equal((await second.request('/api/me')).data.user, null)
  const oldLogin = await client(fx.base).request('/api/auth/login', { method: 'POST', body: { username: 'user_recover', password: 'correct-horse-1' } })
  assert.equal(oldLogin.response.status, 401)
  const newLogin = await client(fx.base).request('/api/auth/login', { method: 'POST', body: { username: 'user_recover', password: 'new-correct-horse' } })
  assert.equal(newLogin.response.status, 200)

  insertUser(fx.app.locals.db, { username: 'admin_one', password: 'admin-password', nickname: '管理员', phone: null, role: 'admin', phoneSecret: 'test-secret' })
  const adminRecovery = await client(fx.base).request('/api/auth/recover', {
    method: 'POST', body: { username: 'admin_one', phone: '13800000007', newPassword: 'stolen-password' }
  })
  assert.equal(adminRecovery.response.status, 400)
  assert.equal(adminRecovery.data.code, 'RECOVERY_MISMATCH')
})

test('login failure limits are per username while the classroom IP allowance stays independent', async (t) => {
  const fx = await fixture({ moderator: allowModerator })
  t.after(fx.close)
  const first = client(fx.base)
  const second = client(fx.base)
  await register(first, 'locked')
  await register(second, 'neighbor')
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const failed = await client(fx.base).request('/api/auth/login', { method: 'POST', body: { username: 'user_locked', password: 'wrong-password' } })
    assert.equal(failed.response.status, 401)
  }
  const limited = await client(fx.base).request('/api/auth/login', { method: 'POST', body: { username: 'user_locked', password: 'wrong-password' } })
  assert.equal(limited.response.status, 429)
  assert.equal(limited.data.code, 'RATE_LIMITED')
  const neighbor = await client(fx.base).request('/api/auth/login', { method: 'POST', body: { username: 'user_neighbor', password: 'correct-horse-1' } })
  assert.equal(neighbor.response.status, 200)
})

test('configured moderation is capped at 50 requests per user per UTC day', async (t) => {
  let profileCalls = 0
  const moderator = {
    ready: true,
    async moderate(snapshot) {
      if (snapshot.content.nickname === '限额测试一' || snapshot.content.nickname === '限额测试二') profileCalls += 1
      return { decision: 'allow', reason: '通过' }
    }
  }
  const fx = await fixture({ moderator })
  t.after(fx.close)
  const api = client(fx.base)
  const user = await register(api, 'dailycap')
  const day = new Date().toISOString().slice(0, 10)
  fx.app.locals.db.prepare('INSERT INTO moderation_user_usage(day,user_id,requests) VALUES(?,?,49)').run(day, user.id)
  const fiftieth = await api.request('/api/profile', { method: 'PATCH', body: { nickname: '限额测试一' } })
  assert.equal(fiftieth.response.status, 200)
  const blocked = await api.request('/api/profile', { method: 'PATCH', body: { nickname: '限额测试二' } })
  assert.equal(blocked.response.status, 429)
  assert.equal(blocked.data.code, 'MODERATION_DAILY_LIMIT')
  assert.equal(profileCalls, 1)
})

test('private media becomes public only through approved work or active settings', async (t) => {
  const fx = await fixture({ moderator: allowModerator, phoneSecret: 'test-secret' })
  t.after(fx.close)
  const owner = client(fx.base)
  await register(owner, 'media')
  const png = await sharp({ create: { width: 24, height: 24, channels: 4, background: '#ff3344' } }).png().toBuffer()
  const upload = await owner.request('/api/uploads', { method: 'POST', body: png, headers: { 'content-type': 'image/png' } })
  assert.equal(upload.response.status, 201)
  const id = upload.data.id
  const anonymous = client(fx.base)
  assert.equal((await anonymous.request(`/api/media/${id}`)).response.status, 404)
  const made = await owner.request('/api/works', {
    method: 'POST', body: { lesson: 1, title: '带封面', url: 'https://workbuddy.link/p/image', coverId: id, publish: true, consent: true }
  })
  assert.equal(made.data.work.coverId, id)
  const publicImage = await anonymous.request(`/api/media/${id}`)
  assert.equal(publicImage.response.status, 200)
  assert.equal(publicImage.response.headers.get('content-type'), 'image/webp')

  insertUser(fx.app.locals.db, { username: 'admin_media', password: 'admin-password', nickname: '管理员', phone: null, role: 'admin', phoneSecret: 'test-secret' })
  const admin = client(fx.base)
  await admin.request('/api/auth/login', { method: 'POST', body: { username: 'admin_media', password: 'admin-password' } })
  const qr = await admin.request('/api/uploads', { method: 'POST', body: png, headers: { 'content-type': 'image/png' } })
  const settings = await admin.request('/api/admin/settings', {
    method: 'PUT', body: { officialAccountName: '勇士公众号', officialQrId: qr.data.id, groupName: '训练营', groupQrId: qr.data.id, groupEnabled: true, groupExpiresAt: '2020-01-01T00:00:00.000Z', announcement: '欢迎' }
  })
  assert.equal(settings.data.settings.officialQrId, qr.data.id)
  assert.equal(settings.data.settings.groupEnabled, true)
  assert.equal(settings.data.settings.groupQrId, qr.data.id)
  const publicSettings = await anonymous.request('/api/settings')
  assert.equal(publicSettings.data.settings.groupEnabled, false)
  assert.equal(publicSettings.data.settings.groupQrId, null)
  assert.equal((await anonymous.request(`/api/media/${qr.data.id}`)).response.status, 200)
})

async function uploadTestImage(api, color) {
  const png = await sharp({ create: { width: 12, height: 12, channels: 4, background: color } }).png().toBuffer()
  const upload = await api.request('/api/uploads', { method: 'POST', body: png, headers: { 'content-type': 'image/png' } })
  assert.equal(upload.response.status, 201)
  return upload.data.id
}
