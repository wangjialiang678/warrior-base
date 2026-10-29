import { emitKeypressEvents } from 'node:readline'
import { validatePassword, validateUsername, insertUser } from './auth.js'
import { openDatabase, resolveDataDir } from './db.js'

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY) throw new Error('非交互终端请通过本机环境变量 ADMIN_PASSWORD 提供密码')
  process.stdout.write(label)
  emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let value = ''
  return new Promise((resolve, reject) => {
    const done = (error) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.off('keypress', onKey)
      process.stdout.write('\n')
      error ? reject(error) : resolve(value)
    }
    const onKey = (str, key) => {
      if (key?.ctrl && key.name === 'c') return done(new Error('已取消'))
      if (key?.name === 'return') return done()
      if (key?.name === 'backspace') value = value.slice(0, -1)
      else if (str && !key?.ctrl && !key?.meta) value += str
    }
    process.stdin.on('keypress', onKey)
  })
}

async function main() {
  const [command, rawUsername] = process.argv.slice(2)
  if (command !== 'create' || !rawUsername) throw new Error('用法: node server/admin.js create <username>')
  const username = validateUsername(rawUsername)
  const password = validatePassword(process.env.ADMIN_PASSWORD || await hiddenPrompt('管理员密码: '))
  const dataDir = resolveDataDir(process.env.DATA_DIR)
  const db = openDatabase(dataDir)
  if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(username)) throw new Error('用户名已存在')
  const user = insertUser(db, {
    username, password, nickname: username, phone: null, role: 'admin',
    phoneSecret: process.env.PHONE_HASH_SECRET || 'warrior-base-local-phone-digest'
  })
  console.log(`已创建管理员 ${user.username}（管理员不支持手机号找回）`)
  db.close()
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
