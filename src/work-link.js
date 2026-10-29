const SHARE_HOSTS = new Set(['workbuddy.link', 'www.workbuddy.link'])
const LOCAL_HINT = '这是本地或局域网地址，其他同学打不开。请在 WorkBuddy 中点击「分享给好友」，再复制生成的分享链接。'

export function localWorkLinkError(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^(?:file:|[a-z]:\\|\/Users\/|\/home\/|\[?::1\]?(?:[:/#?]|$))/i.test(raw)) return LOCAL_HINT
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
    const parts = host.split('.').map(Number)
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host)
    const local4 = ipv4 && (parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 169 && parts[1] === 254))
    const local6 = host === '::1' || host === '::' || /^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(host)
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || local4 || local6) return LOCAL_HINT
  } catch { /* Full format errors are shown after paste/blur, not during typing. */ }
  return ''
}

// Early guidance only. The server remains the authority for allowed domains and safety.
export function workLinkError(value) {
  const raw = String(value || '').trim()
  if (!raw) return '请先粘贴 WorkBuddy 的作品分享链接。'
  const local = localWorkLinkError(raw)
  if (local) return local
  let url
  try { url = new URL(raw) } catch { return '链接不完整，请使用 WorkBuddy 的「复制链接」按钮，粘贴以 https:// 开头的完整分享链接。' }
  if (url.protocol !== 'https:') return '请粘贴以 https:// 开头的 WorkBuddy 分享链接，不是本地预览或文件地址。'
  if (raw.length > 2048 || url.username || url.password || url.port || !SHARE_HOSTS.has(url.hostname.toLowerCase())) return '这不是当前支持的 WorkBuddy 分享链接。请使用「分享给好友」生成的 workbuddy.link 链接，不要复制编辑器或其他网站地址。'
  return ''
}
