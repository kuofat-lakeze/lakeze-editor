import { useEffect, useState } from 'react'
import { api, type Me, type Project } from './api'
import { Login } from './Login'
import { Chat } from './Chat'
import { TopUp } from './TopUp'
import { Admin } from './Admin'

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [view, setView] = useState<'chat' | 'admin'>('chat')
  const [topup, setTopup] = useState(false)

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
    setProjects([p, ...projects]); setCurrent(p.id); setView('chat')
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Lakeze Editor</div>
        <div className="balance card" onClick={() => setTopup(true)}>
          <div className="muted small">點數餘額</div>
          <div className="big">{me.balance}</div>
          <button className="btn primary small block">儲值</button>
        </div>
        <button className="btn block" onClick={newProject}>＋ 新專案</button>
        <nav>
          {projects.map(p => (
            <a key={p.id} className={p.id === current && view === 'chat' ? 'active' : ''}
              onClick={() => { setCurrent(p.id); setView('chat') }}>
              {p.name}{p.id === me.free_project_id && <span className="tag">免費</span>}
            </a>
          ))}
        </nav>
        <div className="me">
          {me.is_admin && <a className={view === 'admin' ? 'small active' : 'small'} onClick={() => setView('admin')}>管理後台</a>}
          <div className="muted small">{me.email}</div>
          <a className="small" onClick={() => api.logout().then(() => setMe(null))}>登出</a>
        </div>
      </aside>
      <main className="main">
        {view === 'admin' && me.is_admin ? <Admin />
          : current ? <Chat key={current} projectId={current} onUsage={refreshMe} onTopUp={() => setTopup(true)} />
            : <div className="center muted">建立一個專案開始剪片。第一個專案免費。</div>}
      </main>
      {topup && <TopUp balance={me.balance} onClose={() => { setTopup(false); refreshMe() }} />}
    </div>
  )
}
