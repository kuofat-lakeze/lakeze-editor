export type Asset = { id: string; kind: 'video' | 'audio' | 'image' | 'file'; name: string; url: string; meta: Record<string, unknown>; created_at: string; version?: number | null; role?: string | null }
export type Part = { type: 'text'; text: string } | { type: 'tool'; name: string }
export type Msg = { id: number | string; role: 'user' | 'assistant'; parts: Part[]; created_at: string; assets?: Asset[] }
export type Project = { id: string; name: string; updated_at?: string; exports?: number; final_version?: number | null }
export type DeliverableVersion = { version: number; created_at: string; videos: Asset[]; covers: Asset[]; main: Asset | null }
export type ShareLink = { id: string; token: string; url: string; version: number | null; allow_download: boolean; note: string; expires_at: string | null; revoked: boolean; views: number; created_at: string }
export type DeliverablesData = { project: { id: string; name: string; final_version: number | null; exports: number }; versions: DeliverableVersion[]; shares: ShareLink[] }
export type ShareView = { project_name: string; note: string; allow_download: boolean; brand: { name: string; tagline: string }; versions: DeliverableVersion[] }
export type GalleryItem = { project_id: string; name: string; version: number; final: boolean; cover: Asset | null; video: Asset | null; updated_at: string }
export type ClientComment = { id: number; name: string; text: string; created_at: string }
export type CreditsSummary = {
  balance: number; purchased: number; refunded: number; used: number; waived: number; revision_points: number; first_video_points: number
  free_project?: { id: string; name: string; exports: number; in_free: boolean; free_revisions_left: number | null } | null
  categories: { id: string; label: string }[]; tool_labels: Record<string, string>
  projects: { id: string; name: string; exports: number; revision_turns: number; free: boolean; updated_at: string
    used: number; waived: number; by_category: Record<string, number>; by_tool: Record<string, number> }[]
  daily: { date: string; used: number; waived: number }[]
}
export type Voice = { voice_id: string; name: string; gender?: string | null; description?: string; preview_url?: string | null; custom?: boolean }
export type CreditState = { balance: number; free_project: boolean; in_free: boolean; free_revisions_left: number | null; exports: number }
export type Shot = { n: number; clip: number; t: number; dur: number; shot: string; role: 'hook' | 'feature' | 'price' | 'cta' }
export type Estimate = { first_video_points: number; revision_points: number; two_revisions_points: number; balance: number; enough_first: boolean; enough_two: boolean; short_first: number; short_two: number }
export type Analysis = {
  summary: string; selling_points: string[]; storyboard: Shot[]; script: { n: number; text: string }[]; transcript_notes: string; missing: string[]
  total_seconds: number; clips: { n: number; dur: number; photo: boolean; name: string }[]; n_clips: number; seconds: number; created_at: string
  estimate: Estimate; charged?: number
}
export type ProjectDetail = Project & { messages: Msg[]; assets: Asset[]; running: boolean; credits: CreditState; final_version?: number | null; exports?: number; client_comments?: ClientComment[]; analysis?: Analysis | null }
export type StorageState = { used_bytes: number; quota_bytes: number; plan: string; renews_at: string | null; over: boolean }
export type StoragePlan = { id: string; gb: number; extra_gb: number; points: number; label: string; twd: number }
export type StorageInfo = StorageState & {
  balance: number; period_days: number; raw_retention_days: number; override_gb: number | null; plans: StoragePlan[]
  projects: { id: string; name: string; final_version: number | null; bytes: number; versions: number }[]
}
export type Me = { id: string; email: string; is_admin: boolean; balance: number; free_project_id: string | null; storage?: StorageState; subscription?: MySubscription | null
  can_clone_voice?: boolean; voice?: MyVoice | null; tier?: string; voice_trial?: { used: number; limit: number } | null
  provider?: 'google' | 'facebook' | null; name?: string | null; test_account?: boolean }
export type Providers = { google: boolean; facebook: boolean }
export type CheckoutResult = { url: string | null; test?: boolean; granted?: number; subscription?: string; balance?: number }
export type Pack = { id: string; twd: number; points: number; label: string; checkout_url: string | null; member_twd: Record<string, number>; member_checkout_url?: Record<string, string | null> }
export type Subscription = { id: string; label: string; who: string; desc: string; features: string[]; videos: number; revisions: number; points: number; storage_gb: number; storage_plan: string
  twd: number; payg_twd: number; save_twd: number; save_pct: number; per_video_twd: number; point_twd: number; member_discount_pct: number; checkout_url?: string | null }
export type MySubscription = { id: string; label: string; points: number; videos: number; storage_gb: number; features: string[]; period_start: string | null; renews_at: string | null }
export type Tier = { id: string; label: string; who: string; features?: string[]; voice_seconds?: number }
export type Pricing = { point_twd: number; menu: { item: string; points: number }[]; free_revision_turns: number; packs: Pack[]; provider_configured: boolean; note: string
  first_video_points: number; revision_points: number; first_video_twd: number; revision_twd: number; subscriptions: Subscription[]; storage_plans: StoragePlan[]
  tiers: { free: Tier; payg: Tier }; free_storage_gb: number; member_point_twd: number; member_discount_pct: number; trial_voice_seconds: number; signup_points: number }
export type MyVoice = { voice_id: string; name: string }
export type Stage = 'disabled' | 'sub' | 'paid' | 'churn' | 'trial_done' | 'trial' | 'new'
export type AdminUser = { id: string; email: string; name?: string | null; provider: string; created_at: string; is_admin: boolean; disabled: boolean; note: string; tags: string[]
  balance: number; waived: number; paid_twd: number; purchases: number; purchased_points: number; granted_points: number; used_points: number; last_purchase_at: string | null
  cost_usd: number; cost_twd: number; projects: number; exports: number; revision_turns: number; last_active: string | null
  storage_plan: string; storage_bytes: number; storage_quota_bytes: number; subscription: string; sub_renews_at: string | null; voice: boolean; stage: Stage }
export type DashRow = { id: string; email: string; name?: string | null; balance: number; paid_twd: number; exports: number; projects: number; subscription: string; last_active: string | null; stage: Stage; points_used?: number }
export type DashPeriod = { revenue_twd: number; points_used: number; points_waived: number; points_sold: number; points_granted: number; exports: number; cost_usd: number; cost_twd: number; signups: number; buyers: number; active_users?: number; margin_pct?: number | null }
export type Dashboard = {
  days: number; generated_at: string
  totals: { users: number; paying_users: number; subscribers: number; mrr_twd: number; revenue_twd: number; points_used: number; exports: number; cost_usd: number; cost_twd: number; conversion_pct: number; points_outstanding: number }
  period: DashPeriod; previous: DashPeriod
  daily: { date: string; signups: number; revenue_twd: number; points_used: number; points_waived: number; cost_twd: number; exports: number; active: number }[]
  tiers: Record<'free' | 'payg' | 'sub5' | 'sub15' | 'disabled', number>; funnel: { label: string; n: number }[]
  by_category: { id: string; label: string; points: number }[]; low_balance: DashRow[]; churn: DashRow[]; top: DashRow[]; recent: DashRow[]
  stages: Record<Stage, string>; point_twd: number
}
export type AdminStats = { users: number; new_users_7d: number; projects: number; exports: number; revenue_twd: number; points_sold: number; points_used: number; points_waived: number; cost_usd: number; claude_cost_usd: number; eleven_cost_usd: number }
export type Ledger = { id?: number; delta: number; waived: number; kind: string; reason: string; amount_twd?: number; project_id: string | null; created_at: string }
export type AdminUserDetail = { id: string; email: string; name?: string | null; provider: string; is_admin: boolean; disabled: boolean; note: string; tags: string[]; created_at: string; last_active: string | null
  subscription: string; sub_period_start: string | null; sub_renews_at: string | null; storage_plan: string; storage_quota_gb: number | null; storage_bytes: number; storage_quota_bytes: number
  voice: { voice_id: string; name: string | null } | null; voice_trial_seconds: number; stage: Stage
  summary: { balance: number; paid_twd: number; purchases: number; purchased_points: number; granted_points: number; used_points: number; expired_points: number; waived_points: number; cost_usd: number; cost_twd: number; profit_twd: number; margin_pct: number | null; exports: number; revision_turns: number }
  by_category: { id: string; label: string; points: number }[]; daily: { date: string; points: number; cost_twd: number }[]
  ledger: (Ledger & { meta?: Record<string, unknown> })[]
  projects: { id: string; name: string; exports: number; revision_turns: number; final_version: number | null; free: boolean; cost_usd: number; created_at: string; updated_at: string }[] }

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
  authProviders: () => fetch('/api/auth/providers').then(j<Providers>).catch(() => ({ google: false, facebook: false } as Providers)),
  oauthStart: (p: 'google' | 'facebook', mode: 'login' | 'signup', next?: string) => `/api/auth/${p}/start?mode=${mode}${next ? `&next=${encodeURIComponent(next)}` : ''}`,
  analyze: async (id: string, body: { brief?: string; drive_url?: string }) => {
    const r = await post(`/api/projects/${id}/analyze`, body)
    if (r.status === 402) { const d = await r.json(); throw Object.assign(new Error(d.detail), { needed: d.needed as number, balance: d.balance as number }) }
    return j<Analysis>(r)
  },
  frameUrl: (id: string, clip: number, t: number) => `/api/projects/${id}/frame/${clip}?t=${t}`,
  projects: () => fetch('/api/projects').then(j<Project[]>),
  createProject: (name: string) => post('/api/projects', { name }).then(j<Project>),
  project: (id: string) => fetch(`/api/projects/${id}`).then(j<ProjectDetail>),
  send: (id: string, text: string, extra: { with_analysis?: boolean } = {}) => post(`/api/projects/${id}/messages`, { text, ...extra }).then(j<{ ok: boolean }>),
  cancel: (id: string) => post(`/api/projects/${id}/cancel`, {}),
  pricing: () => fetch('/api/pricing').then(j<Pricing>),
  voices: () => fetch('/api/voices').then(j<Voice[]>),
  credits: () => fetch('/api/credits').then(j<{ balance: number; ledger: Ledger[] }>),
  creditsSummary: () => fetch('/api/credits/summary').then(j<CreditsSummary>),
  deliverables: (id: string) => fetch(`/api/projects/${id}/deliverables`).then(j<DeliverablesData>),
  setFinal: (id: string, version: number | null) => post(`/api/projects/${id}/final`, { version }).then(j<{ ok: boolean }>),
  createShare: (id: string, body: { version: number | null; allow_download: boolean; expires_days: number | null; note: string }) =>
    post(`/api/projects/${id}/share`, body).then(j<ShareLink>),
  revokeShare: (id: string, shareId: string) => post(`/api/projects/${id}/share/${shareId}/revoke`, {}).then(j<{ ok: boolean }>),
  deleteVersion: (id: string, version: number) => fetch(`/api/projects/${id}/versions/${version}`, { method: 'DELETE' }).then(j<{ ok: boolean; freed_bytes: number; storage: StorageState }>),
  storage: () => fetch('/api/storage').then(j<StorageInfo>),
  cloneVoice: (fd: FormData) => fetch('/api/voice/clone', { method: 'POST', body: fd }).then(j<{ ok: boolean; voice: Voice; seconds: number }>),
  deleteVoice: () => fetch('/api/voice/clone', { method: 'DELETE' }).then(j<{ ok: boolean }>),
  setStoragePlan: (plan: string) => post('/api/storage/plan', { plan }).then(j<{ ok: boolean; storage: StorageState; balance?: number }>),
  share: (token: string) => fetch(`/api/s/${token}`).then(j<ShareView>),
  shareComment: (token: string, name: string, text: string) => post(`/api/s/${token}/comment`, { name, text }).then(j<{ ok: boolean }>),
  gallery: () => fetch('/api/gallery').then(j<GalleryItem[]>),
  checkout: (pack: string) => fetch(`/api/checkout/${pack}`).then(j<CheckoutResult>),
  admin: {
    dashboard: (days = 30) => fetch(`/api/admin/dashboard?days=${days}`).then(j<Dashboard>),
    csvUrl: (q = '') => `/api/admin/users.csv?q=${encodeURIComponent(q)}`,
    users: (q = '') => fetch(`/api/admin/users?q=${encodeURIComponent(q)}`).then(j<AdminUser[]>),
    user: (id: string) => fetch(`/api/admin/users/${id}`).then(j<AdminUserDetail>),
    grant: (id: string, delta: number, reason: string, amount_twd: number) =>
      post(`/api/admin/users/${id}/credits`, { delta, reason, amount_twd }).then(j<{ balance: number }>),
    patch: (id: string, body: Record<string, unknown>) => post(`/api/admin/users/${id}`, body).then(j<{ ok: boolean }>),
    subscription: (id: string, plan: string, paid_twd = 0) => post(`/api/admin/users/${id}/subscription`, { plan, paid_twd }).then(j<{ expired: number; granted?: number }>),
    messages: (pid: string) => fetch(`/api/admin/projects/${pid}/messages`).then(j<{ role: string; text?: string; tool?: string; at: string }[]>),
  },
  // Chunked upload. Railway's edge drops any request whose body takes more than 5 minutes to
  // arrive, so a big clip goes up in 8 MB pieces: one short request each, each retried on its own,
  // so a phone on mobile data can lose a few packets without losing the file.
  uploadOne: async (id: string, file: File, onProgress: (loaded: number, total: number) => void) => {
    const CHUNK = 8 * 2 ** 20
    const begin = await post(`/api/projects/${id}/upload/begin`, { name: file.name || 'clip.mp4', size: file.size }).then(j<{ upload_id: string }>)
    const putChunk = (offset: number, blob: Blob) => new Promise<void>((resolve, reject) => {
      const x = new XMLHttpRequest()
      x.open('PUT', `/api/projects/${id}/upload/${begin.upload_id}/chunk?offset=${offset}`)
      x.setRequestHeader('content-type', 'application/octet-stream')
      x.timeout = 240000
      x.upload.onprogress = e => onProgress(offset + e.loaded, file.size)
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`HTTP ${x.status} ${x.responseText.slice(0, 200)}`)))
      x.onerror = () => reject(new Error(`連線中斷（status ${x.status || 0}，readyState ${x.readyState}）`))
      x.onabort = () => reject(new Error('上傳被中止'))
      x.ontimeout = () => reject(new Error('上傳逾時'))
      x.send(blob)
    })
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const blob = file.slice(offset, Math.min(offset + CHUNK, file.size))
      let attempt = 0
      for (;;) {
        try { await putChunk(offset, blob); break } catch (e) {
          const status = Number((/HTTP (\d+)/.exec((e as Error).message) || [])[1] || 0)
          if (++attempt > 4 || (status >= 400 && status < 500 && status !== 408 && status !== 429)) throw e
          await new Promise(r => setTimeout(r, 1500 * attempt))
        }
      }
    }
    await post(`/api/projects/${id}/upload/${begin.upload_id}/complete`, {}).then(j<{ saved: unknown[] }>)
    onProgress(file.size, file.size)
  },
  // Fire-and-forget diagnostics from the browser (shows up in the backend log as "client ...").
  clientLog: (event: string, detail: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ event, detail: { ...detail, ua: navigator.userAgent, url: location.pathname } })
    try { if (!navigator.sendBeacon?.('/api/client-log', new Blob([body], { type: 'application/json' }))) throw 0 }
    catch { fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {}) }
  },
}
