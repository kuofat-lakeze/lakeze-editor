import { useEffect, useState } from 'react'
import { api, type Me, type Project } from './api'
import { Login } from './Login'
import { Chat } from './Chat'
import { Credits, type CreditsTab } from './Credits'
import { DashboardApp } from './Dashboard'
import { Gallery } from './Gallery'
import { SharePage } from './SharePage'
import { Landing } from './Landing'
import logo from './assets/logo.png'
import { StorageMeter } from './Storage'

const SHARE_TOKEN = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/)?.[1]
// The CRM lives at /dashboard on the app host and is the whole site on dashboard.<app host>.
const IS_DASH = location.hostname.startsWith('dashboard.') || /^\/dashboard(\/|$)/.test(location.pathname)

export default function App() {
  if (SHARE_TOKEN) return <SharePage token={SHARE_TOKEN} />
  if (IS_DASH) return <DashboardGate />
  return <Workspace />
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

  const refreshMe = () => api.me().then(setMe)
  useEffect(() => { refreshMe() }, [])
  useEffect(() => {
    if (!me) return
    api.projects().then(ps => { setProjects(ps); if (!current && ps[0]) setCurrent(ps[0].id) })
  }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined) return <div className="center muted">載入中…</div>
  if (!me) return auth
    ? <Login initialMode={auth} initialError={oauthError} onDone={m => { setMe(m); history.replaceState(null, '', '/') }} onBack={() => { setAuth(null); history.replaceState(null, '', '/') }} />
    : <Landing onStart={() => { setAuth('signup'); history.pushState(null, '', '/signup') }} onLogin={() => { setAuth('login'); history.pushState(null, '', '/login') }} />

  const newProject = async () => {
    const name = prompt('專案名稱（例如：雲岫海景渡假會館）')
    if (!name) return
    const p = await api.createProject(name)
    setProjects([p, ...projects]); setCurrent(p.id); setView('chat'); setMenu(false)
  }
  const openProject = (id: string) => { setCurrent(id); setView('chat'); setMenu(false) }
  const currentName = projects.find(p => p.id === current)?.name

  return (
    <div className="layout">
      {/* phone top bar: logo, balance, menu */}
      <div className="topbar">
        <button className="btn icon" aria-label="選單" onClick={() => setMenu(true)}>☰</button>
        <img className="logo" src={logo} alt="Lakeze 人客多" />
        <span className="spacer" />
        <a className="pts" onClick={() => showCredits()}>{me.balance} <small>點</small></a>
      </div>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}

      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="brand"><img className="logo" src={logo} alt="Lakeze 人客多" /></div>
        <div className={`balance card ${view === 'credits' ? 'active' : ''}`} onClick={() => showCredits()}>
          <div className="muted small">點數餘額</div>
          <div className="big">{me.balance}</div>
          <button className="btn primary small" onClick={e => { e.stopPropagation(); showCredits('buy') }}>儲值</button>
          <div className="side-sub small"><a onClick={e => { e.stopPropagation(); showCredits('plans') }}>{me.subscription ? `訂閱中 · ${me.subscription.label}` : '看方案'}</a></div>
        </div>
        {me.storage && <div className="side-storage" onClick={() => showCredits('storage')}><StorageMeter s={me.storage} compact /></div>}
        <button className="btn block" onClick={newProject}>＋ 新專案</button>
        <a className={`navlink ${view === 'gallery' ? 'active' : ''}`} onClick={() => { setView('gallery'); setMenu(false) }}>作品庫</a>
        <nav>
          {projects.map(p => (
            <a key={p.id} className={p.id === current && view === 'chat' ? 'active' : ''} onClick={() => openProject(p.id)}>
              {p.final_version != null && <span className="done-mark" title="已交付">✓</span>}{p.name}{p.id === me.free_project_id && <span className="tag">免費</span>}
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
        {view === 'gallery' ? <Gallery onOpen={openProject} />
          : view === 'credits' ? <Credits key={creditsTab + me.balance} initialTab={creditsTab} needPoints={needPoints} onClose={() => { setView('chat'); refreshMe() }} onOpenProject={openProject} onBought={refreshMe} />
          : current ? <Chat key={current} projectId={current} name={currentName} onUsage={refreshMe} onTopUp={need => showCredits('buy', need)} onCredits={() => showCredits()} onStorage={() => showCredits('storage')}
              onProjectsChanged={() => api.projects().then(setProjects)} />
            : <div className="center muted">建立一個專案開始剪片。第一個專案免費。</div>}
      </main>
    </div>
  )
}
