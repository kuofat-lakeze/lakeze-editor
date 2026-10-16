import { useEffect, useState } from 'react'
import { api, type Me, type Project } from './api'
import { Login } from './Login'
import { Chat } from './Chat'
import { Credits, type CreditsTab } from './Credits'
import { Admin } from './Admin'
import logo from './assets/logo.png'

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'admin' | 'credits'>('chat')
  const [creditsTab, setCreditsTab] = useState<CreditsTab>('overview')
  const showCredits = (t: CreditsTab = 'overview') => { setCreditsTab(t); setView('credits'); setMenu(false) }
  const [menu, setMenu] = useState(false)

  const refreshMe = () => api.me().then(setMe)
  useEffect(() => { refreshMe() }, [])
  useEffect(() => {
    if (!me) return
    api.projects().then(ps => { setProjects(ps); if (!current && ps[0]) setCurrent(ps[0].id) })
  }, [me?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined) return <div className="center muted">載入中…</div>
  if (!me) return <Login onDone={setMe} />

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
        </div>
        <button className="btn block" onClick={newProject}>＋ 新專案</button>
        <nav>
          {projects.map(p => (
            <a key={p.id} className={p.id === current && view === 'chat' ? 'active' : ''} onClick={() => openProject(p.id)}>
              {p.name}{p.id === me.free_project_id && <span className="tag">免費</span>}
            </a>
          ))}
        </nav>
        <div className="me">
          {me.is_admin && <a className={view === 'admin' ? 'small active' : 'small'} onClick={() => { setView('admin'); setMenu(false) }}>管理後台</a>}
          <div className="muted small">{me.email}</div>
          <a className="small" onClick={() => api.logout().then(() => setMe(null))}>登出</a>
        </div>
      </aside>

      <main className="main">
        {view === 'admin' && me.is_admin ? <Admin />
          : view === 'credits' ? <Credits key={creditsTab + me.balance} initialTab={creditsTab} onClose={() => { setView('chat'); refreshMe() }} />
          : current ? <Chat key={current} projectId={current} name={currentName} onUsage={refreshMe} onTopUp={() => showCredits('buy')} onCredits={() => showCredits()} />
            : <div className="center muted">建立一個專案開始剪片。第一個專案免費。</div>}
      </main>
    </div>
  )
}
