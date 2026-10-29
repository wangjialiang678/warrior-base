export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: options.body instanceof File || options.body instanceof Blob
      ? options.headers
      : { 'Content-Type': 'application/json', ...options.headers },
  })
  const type = response.headers.get('content-type') || ''
  const data = type.includes('application/json') ? await response.json() : null
  if (!response.ok) {
    throw new ApiError(data?.error || '请求失败，请稍后再试', response.status, data?.code)
  }
  return data
}

export function uploadImage(file) {
  return api('/uploads', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type },
  })
}

export function mediaUrl(id) {
  return id ? `/api/media/${encodeURIComponent(id)}` : ''
}
