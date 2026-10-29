export const UNCONFIGURED_MESSAGE = '自动审核尚未配置，作品已保存，暂未公开'
export const LOCAL_DEMO_MESSAGE = '本机演示，未启用真实 AI 审核'

export function createModerationAdapter({ url, token, timeoutMs = 6000, fetchImpl = fetch } = {}) {
  const ready = Boolean(url && token)
  return {
    ready,
    async moderate(snapshot) {
      if (!ready) return { decision: 'review', reason: UNCONFIGURED_MESSAGE }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(snapshot),
          signal: controller.signal
        })
        if (!response.ok) return { decision: 'review', reason: '自动审核服务暂时不可用，已转为待审' }
        const value = await response.json()
        const decision = ['allow', 'reject', 'review'].includes(value?.decision) ? value.decision : 'review'
        const covered = value?.coverage?.text === true && (!snapshot.image || value?.coverage?.images === true)
        if (!covered) return { decision: 'review', reason: '自动审核结果不完整，已转为待审' }
        return { decision, reason: cleanReason(value.reason) }
      } catch {
        return { decision: 'review', reason: '自动审核服务暂时不可用，已转为待审' }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

export function createLocalDemoModeration() {
  return {
    ready: false,
    async moderate() { return { decision: 'allow', reason: LOCAL_DEMO_MESSAGE } }
  }
}

function cleanReason(value) {
  return typeof value === 'string' ? value.slice(0, 300) : ''
}
