export type Asset = { id: string; kind: 'video' | 'audio' | 'image' | 'file'; name: string; url: string; meta: Record<string, unknown>; created_at: string }
export type Part = { type: 'text'; text: string } | { type: 'tool'; name: string }
export type Msg = { id: number | string; role: 'user' | 'assistant'; parts: Part[]; created_at: string; assets?: Asset[] }
export type Project = { id: string; name: string; updated_at?: string }
export type CreditState = { balance: number; free_project: boolean; in_free: boolean; free_revisions_left: number | null; exports: number }
export type ProjectDetail = Project & { messages: Msg[]; assets: Asset[]; running: boolean; credits: CreditState }
export type Me = { id: string; email: string; is_admin: boolean; balance: number; free_project_id: string | null }
export type Pack = { id: string; twd: number; points: number; label: string; checkout_url: string | null }
export type Pricing = { point_twd: number; menu: { item: string; points: number }[]; free_revision_turns: number; packs: Pack[]; provider_configured: boolean; note: string }
export type AdminUser = { id: string; email: string; created_at: string; is_admin: boolean; disabled: boolean; note: string; balance: number; waived: number; paid_twd: number; cost_usd: number; projects: number; exports: number }
export type AdminStats = { users: number; new_users_7d: number; projects: number; exports: number; revenue_twd: number; points_sold: number; points_used: number; points_waived: number; cost_usd: number; claude_cost_usd: number; eleven_cost_usd: number }
export type Ledger = { id?: number; delta: number; waived: number; kind: string; reason: string; amount_twd?: number; project_id: string | null; created_at: string }
export type AdminUserDetail = { id: string; email: string; is_admin: boolean; disabled: boolean; note: string; created_at: string; ledger: Ledger[]; projects: { id: string; name: string; exports: number; revision_turns: number; free: boolean; cost_usd: number; updated_at: string }[] }

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
  pricing: () => fetch('/api/pricing').then(j<Pricing>),
  credits: () => fetch('/api/credits').then(j<{ balance: number; ledger: Ledger[] }>),
  checkout: (pack: string) => fetch(`/api/checkout/${pack}`).then(j<{ url: string }>),
  admin: {
    stats: () => fetch('/api/admin/stats').then(j<AdminStats>),
    users: (q = '') => fetch(`/api/admin/users?q=${encodeURIComponent(q)}`).then(j<AdminUser[]>),
    user: (id: string) => fetch(`/api/admin/users/${id}`).then(j<AdminUserDetail>),
    grant: (id: string, delta: number, reason: string, amount_twd: number) =>
      post(`/api/admin/users/${id}/credits`, { delta, reason, amount_twd }).then(j<{ balance: number }>),
    patch: (id: string, body: Record<string, unknown>) => post(`/api/admin/users/${id}`, body).then(j<{ ok: boolean }>),
    messages: (pid: string) => fetch(`/api/admin/projects/${pid}/messages`).then(j<{ role: string; text?: string; tool?: string; at: string }[]>),
  },
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
