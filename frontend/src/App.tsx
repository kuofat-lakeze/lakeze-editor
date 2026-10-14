import { useEffect, useState } from 'react'
import { api, type Me, type Project } from './api'
import { Login } from './Login'
import { Chat } from './Chat'

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<string | null>(null)

  useEffect(() => { api.me().then(setMe) }, [])
  useEffect(() => {
    if (!me) return
    api.projects().then(ps => { setProjects(ps); if (!current && ps[0]) setCurrent(ps[0].id) })
  }, [me]) // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined) return <div className="center muted">載入中…</div>
  if (!me) return <Login onDone={setMe} />

  const newProject = async () => {
    const name = prompt('專案名稱（例如：雲岫海景渡假會館）')
    if (!name) return
    const p = await api.createProject(name)
    setProjects([p, ...projects]); setCurrent(p.id)
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Lakeze Editor</div>
        <button className="btn primary block" onClick={newProject}>＋ 新專案</button>
        <nav>
          {projects.map(p => (
            <a key={p.id} className={p.id === current ? 'active' : ''} onClick={() => setCurrent(p.id)}>{p.name}</a>
          ))}
        </nav>
        <div className="me">
          <div className="muted small">{me.email}</div>
          <div className="muted small">用量 ${me.spent_usd.toFixed(2)}</div>
          <a className="small" onClick={() => api.logout().then(() => setMe(null))}>登出</a>
        </div>
      </aside>
      <main className="main">
        {current ? <Chat key={current} projectId={current} onUsage={() => api.me().then(setMe)} />
          : <div className="center muted">建立一個專案開始剪片。</div>}
      </main>
    </div>
  )
}
