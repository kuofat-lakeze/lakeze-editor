export type Asset = { id: string; kind: 'video' | 'audio' | 'image' | 'file'; name: string; url: string; meta: Record<string, unknown>; created_at: string }
export type Part = { type: 'text'; text: string } | { type: 'tool'; name: string }
export type Msg = { id: number | string; role: 'user' | 'assistant'; parts: Part[]; created_at: string; assets?: Asset[] }
export type Project = { id: string; name: string; updated_at?: string }
export type ProjectDetail = Project & { messages: Msg[]; assets: Asset[]; running: boolean }
export type Me = { id: string; email: string; spent_usd: number }

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let d = r.statusText
    try { d = (await r.json()).detail ?? d } catch { /* ignore */ }
    throw new Error(typeof d === 'string' ? d : JSON.stringify(d))
  }
  return r.json()
}
const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const api = {
  me: () => fetch('/api/me').then(r => (r.ok ? r.json() : null)) as Promise<Me | null>,
  login: (email: string, password: string) => post('/api/auth/login', { email, password }).then(j<Me>),
  signup: (email: string, password: string) => post('/api/auth/signup', { email, password }).then(j<Me>),
  logout: () => post('/api/auth/logout', {}),
  projects: () => fetch('/api/projects').then(j<Project[]>),
  createProject: (name: string) => post('/api/projects', { name }).then(j<Project>),
  project: (id: string) => fetch(`/api/projects/${id}`).then(j<ProjectDetail>),
  send: (id: string, text: string) => post(`/api/projects/${id}/messages`, { text }).then(j<{ ok: boolean }>),
  cancel: (id: string) => post(`/api/projects/${id}/cancel`, {}),
  upload: (id: string, files: FileList, onProgress: (pct: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const fd = new FormData()
      Array.from(files).forEach(f => fd.append('files', f))
      const x = new XMLHttpRequest()
      x.open('POST', `/api/projects/${id}/upload`)
      x.upload.onprogress = e => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100))
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error(x.responseText)))
      x.onerror = () => reject(new Error('upload failed'))
      x.send(fd)
    }),
}
