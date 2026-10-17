import { useEffect, useRef, useState } from 'react'
import { api, type Me, type Notifications, type Project } from './api'
import { Login } from './Login'
import { Chat } from './Chat'
import { Credits, type CreditsTab } from './Credits'
import { DashboardApp } from './Dashboard'
import { Gallery } from './Gallery'
import { SharePage } from './SharePage'
import { Landing } from './Landing'
import logo from './assets/logo.png'
import { StorageMeter } from './Storage'
import { MiaoLogo } from './Logo'
import { PayResult } from './Pay'
import { InAppGuide } from './InApp'
import { ask, DialogHost } from './Dialog'

const SHARE_TOKEN = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/)?.[1]
// The CRM lives at /dashboard on the app host and is the whole site on dashboard.<app host>.
const IS_DASH = location.hostname.startsWith('dashboard.') || /^\/dashboard(\/|$)/.test(location.pathname)

export default function App() {
  return <>
    {SHARE_TOKEN ? <SharePage token={SHARE_TOKEN} /> : IS_DASH ? <DashboardGate /> : <Workspace />}
    <DialogHost />
  </>
}

function DashboardGate() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  useEffect(() => { api.me().then(setMe) }, [])
  const oauthError = new URLSearchParams(location.search).get('oauth_error') ?? ''
  if (me === undefined) return <div className="center muted">載入中…</div>
  if (!me) return <Login initialMode="login" initialError={oauthError} next={location.href.split('?')[0]} onDone={setMe} />
  if (!me.is_admin) return (
    <div className="center" style={{ flexDirection: 'column', gap: 10 }}>
      <b>這個帳號沒有管理權限</b><span className="muted small">{me.email}</span>
      <a className="small" onClick={() => api.logout().then(() => setMe(null))}>換個帳號登入</a>
    </div>)
  return <DashboardApp me={me} onLogout={() => api.logout().then(() => setMe(null))} />
}

function Workspace() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'credits' | 'gallery'>('chat')
  const [creditsTab, setCreditsTab] = useState<CreditsTab>('overview')
  const [needPoints, setNeedPoints] = useState(0)
  const showCredits = (t: CreditsTab = 'plans', need = 0) => { setCreditsTab(t); setNeedPoints(need); setView('credits'); setMenu(false) }
  const [menu, setMenu] = useState(false)
  const [auth, setAuth] = useState<'login' | 'signup' | null>(location.pathname === '/login' ? 'login' : location.pathname === '/signup' ? 'signup' : null)
  const oauthError = new URLSearchParams(location.search).get('oauth_error') ?? ''   // the OAuth callback lands on /login?oauth_error=…
  const refToken = new URLSearchParams(location.search).get('ref') ?? ''              // arrived from a friend's share page
  // 朋友的反饋: polled quietly; a badge per project, a toast when something new arrives. Never interrupts a running turn.
  const [notes, setNotes] = useState<Notifications | null>(null)
  const [toast, setToast] = useState<{ text: string; project_id: string } | null>(null)
  const seen = useRef<number | null>(null)
  const pollNotes = () => api.notifications().then(n => {
    setNotes(n)
    if (seen.current !== null && n.unread > seen.current && n.items[0]) {
      const it = n.items[0]
      setToast({ text: `${it.name || '朋友'} 對「${it.project_name}」留了反饋：${it.text.slice(0, 40)}`, project_id: it.project_id! })
      setTimeout(() => setToast(null), 8000)
    }
    seen.current = n.unread
  }).catch(() => {})
  useEffect(() => {
    if (!me) return
    pollNotes()
    const t = setInterval(pollNotes, 45000)
    const onVis = () => { if (document.visibilityState === 'visible') pollNotes() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis) }
  }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { document.title = (notes?.unread ? `(${notes.unread}) ` : '') + '旅剪 · 人客多 Lakeze' }, [notes?.unread])

  const refreshMe = () => api.me().then(setMe)
  const [payOrder, setPayOrder] = useState<string | null>(location.pathname === '/pay/result' ? new URLSearchParams(location.search).get('order') : null)
  useEffect(() => { refreshMe() }, [])
  useEffect(() => {
    if (!me) return
    api.projects().then(ps => { setProjects(ps); if (!current && ps[0]) setCurrent(ps[0].id) })
  }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined) return <div className="center muted">載入中…</div>
  if (!me) return <><InAppGuide />{auth
    ? <Login initialMode={auth} initialError={oauthError} refToken={refToken} onDone={m => { setMe(m); history.replaceState(null, '', '/') }} onBack={() => { setAuth(null); history.replaceState(null, '', '/') }} />
    : <Landing onStart={() => { setAuth('signup'); history.pushState(null, '', '/signup') }} onLogin={() => { setAuth('login'); history.pushState(null, '', '/login') }} />}</>

  const newProject = async () => {
    const name = (await ask.prompt('幫這個新專案取個名字', { placeholder: '例如：雲岫海景渡假會館', ok: '建立專案' }))?.trim()
    if (!name) return
    const p = await api.createProject(name)
    setProjects([p, ...projects]); setCurrent(p.id); setView('chat'); setMenu(false)
  }
  const openProject = (id: string) => { setCurrent(id); setView('chat'); setMenu(false) }
  const currentName = projects.find(p => p.id === current)?.name

  return (
    <div className="layout">
      <InAppGuide />
      {/* phone top bar: logo, balance, menu */}
      <div className="topbar">
        <button className="btn icon" aria-label="選單" onClick={() => setMenu(true)}>☰</button>
        <MiaoLogo size={26} className="top-miao" />
        <span className="spacer" />
        {(notes?.unread ?? 0) > 0 && <a className="fb-top" onClick={() => { const it = notes!.items[0]; if (it?.project_id) openProject(it.project_id) }}>💬 {notes!.unread}</a>}
        <a className="pts" onClick={() => showCredits()}>{me.balance} <small>點</small></a>
      </div>
      {toast && <a className="fb-toast" onClick={() => { openProject(toast.project_id); setToast(null) }}><b>朋友的反饋</b>{toast.text}<small>點一下查看</small></a>}
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}

      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand"><MiaoLogo size={34} /><img className="logo brand-by" src={logo} alt="人客多 Lakeze" title="人客多 Lakeze" /></div>
        <div className={`balance card ${view === 'credits' ? 'active' : ''}`} onClick={() => showCredits()}>
          <div className="muted small">點數餘額</div>
          <div className="big">{me.balance}</div>
          <button className="btn primary small" onClick={e => { e.stopPropagation(); showCredits(me.subscription ? 'buy' : 'plans') }}>{me.subscription ? '加購' : '儲值'}</button>
          <div className="side-sub small"><a onClick={e => { e.stopPropagation(); showCredits('plans') }}>{me.subscription ? `訂閱中 · ${me.subscription.label}` : '看方案'}</a></div>
        </div>
        {me.storage && <div className="side-storage" onClick={() => showCredits('storage')}><StorageMeter s={me.storage} compact /></div>}
        <button className="btn block" onClick={newProject}>＋ 新專案</button>
        <a className={`navlink ${view === 'gallery' ? 'active' : ''}`} onClick={() => { setView('gallery'); setMenu(false) }}>作品庫</a>
        <nav>
          {projects.map(p => (
            <a key={p.id} className={p.id === current && view === 'chat' ? 'active' : ''} onClick={() => openProject(p.id)}>
              {p.final_version != null && <span className="done-mark" title="已交付">✓</span>}{p.name}{p.id === me.free_project_id && <span className="tag">免費</span>}
              {(notes?.by_project[p.id] ?? 0) > 0 && <span className="fb-badge" title="朋友的新反饋">{notes!.by_project[p.id]}</span>}
            </a>
          ))}
        </nav>
        <div className="me">
          {me.is_admin && <a className="small" href="/dashboard">管理後台 ↗</a>}
          <div className="muted small">{me.email}</div>
          <a className="small" onClick={() => api.logout().then(() => setMe(null))}>登出</a>
        </div>
      </aside>

      <main className="main">
        {payOrder ? <PayResult orderId={payOrder} onDone={() => { setPayOrder(null); history.replaceState(null, '', '/'); refreshMe() }} />
          : view === 'gallery' ? <Gallery onOpen={openProject} />
          : view === 'credits' ? <Credits key={creditsTab + me.balance} initialTab={creditsTab} needPoints={needPoints} onClose={() => { setView('chat'); refreshMe() }} onOpenProject={openProject} onBought={refreshMe} />
          : current ? <Chat key={current} projectId={current} name={currentName} onUsage={refreshMe} onTopUp={need => showCredits(me.subscription ? 'buy' : 'plans', need)} onCredits={() => showCredits()} onStorage={() => showCredits('storage')}
              onProjectsChanged={() => api.projects().then(setProjects)} feedbackUnread={notes?.by_project[current] ?? 0} onFeedbackRead={pollNotes} />
            : <div className="center muted">建立一個專案開始剪片。第一個專案免費。</div>}
      </main>
    </div>
  )
}
