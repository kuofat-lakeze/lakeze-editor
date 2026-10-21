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
import { LegalPage } from './Legal'

const SHARE_TOKEN = location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)/)?.[1]
// The CRM lives at /dashboard on the app host and is the whole site on dashboard.<app host>.
const IS_DASH = location.hostname.startsWith('dashboard.') || /^\/dashboard(\/|$)/.test(location.pathname)
const LEGAL_PAGE = location.pathname === '/privacy' ? 'privacy' : location.pathname === '/terms' ? 'terms' : null

/* 專案名稱 examples, one list per kind of video. Each time the dialog opens it shows one name from
   each of a few different kinds (住宿、食記、景點、開箱、活動、店家), so people see the range, not one genre. */
const PROJECT_EXAMPLES: string[][] = [
  ['雲岫海景渡假會館', '礁溪溫泉 villa 秋季', '墾丁包棟泳池趴', '北投溫泉飯店評測', '清境雲海小木屋'],
  ['東林餐館 桌邊片烤鴨', '台南巷弄老宅咖啡', '基隆夜市蟹肉羹食記', '阿嬤的古早味肉粽', '板橋深夜拉麵'],
  ['花蓮七星潭一日遊', '阿里山日出小旅行', '九份夜景老街散步', '日月潭環湖自行車', '高雄駁二文青一日'],
  ['新竹露營車開箱', '民宿早餐開箱', '新款電動滑板車開箱', '露營帳篷開箱', '家具展示間導覽'],
  ['台東熱氣球嘉年華', '澎湖花火節', '健身房開幕派對', '公司尾牙花絮', '婚禮戶外證婚'],
  ['烘焙工作室新品', '美甲工作室春季款', '寵物美容沙龍', '手作陶藝體驗課', '二手書店巡禮'],
]
const pickExamples = (n: number) => {
  const idx = PROJECT_EXAMPLES.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
  return idx.slice(0, n).map(i => { const k = PROJECT_EXAMPLES[i]; return { label: k[Math.floor(Math.random() * k.length)], kind: KIND_NAMES[i] } })
}
const KIND_NAMES = ['住宿', '食記', '景點', '開箱', '活動', '店家']
const FIRST_KINDS: { name: string; kind: number }[] = [{ name: '民宿介紹', kind: 0 }, { name: '餐廳食記', kind: 1 }, { name: '景點一日遊', kind: 2 }, { name: '新品開箱', kind: 3 }, { name: '活動花絮', kind: 4 }, { name: '店家介紹', kind: 5 }]

import { VersionBar } from './Version'
import { IcPlay } from './icons'

export default function App() {
  return <>
    <VersionBar />
    {LEGAL_PAGE ? <LegalPage kind={LEGAL_PAGE} /> : SHARE_TOKEN ? <SharePage token={SHARE_TOKEN} /> : IS_DASH ? <DashboardGate /> : <Workspace />}
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
  useEffect(() => { document.title = (notes?.unread ? `(${notes.unread}) ` : '') + '旅剪 Tripcut · 人客多 Lakeze' }, [notes?.unread])

  const refreshMe = () => api.me().then(setMe)
  // 輕鬆模式 / 導演模式: an account setting; the body class scales type for the easy mode.
  const easy = !!me && me.ui_mode !== 'pro'
  useEffect(() => { document.body.classList.toggle('easy', easy) }, [easy])
  const setMode = (mode: 'easy' | 'pro') => { if (!me) return; setMe({ ...me, ui_mode: mode }); api.setMode(mode).catch(() => refreshMe()) }
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

  const newProject = async (prefill = '') => {
    const ex = pickExamples(4)
    const name = (await ask.prompt('幫這個新專案取個名字', { placeholder: `例如：${ex[0].label}`, examples: ex, value: prefill, ok: '建立專案' }))?.trim()
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
        <div className="brand"><MiaoLogo size={34} en={false} /><img className="logo brand-by" src={logo} alt="人客多 Lakeze" title="人客多 Lakeze" /></div>
        <div className={`balance card ${view === 'credits' ? 'active' : ''}`} onClick={() => showCredits()}>
          <div className="muted small">點數餘額</div>
          <div className="big">{me.balance}</div>
          <button className="btn primary small" onClick={e => { e.stopPropagation(); showCredits(me.subscription ? 'buy' : 'plans') }}>{me.subscription ? '加購' : '儲值'}</button>
          <div className="side-sub small"><a onClick={e => { e.stopPropagation(); showCredits('plans') }}>{me.subscription ? `訂閱中 · ${me.subscription.label}` : '看方案'}</a></div>
        </div>
        {me.storage && <div className="side-storage" onClick={() => showCredits('storage')}><StorageMeter s={me.storage} compact /></div>}
        <a className="side-ref" onClick={() => showCredits('referral')}>
          <span className="side-ref-ic" aria-hidden="true">🎁</span><b>推薦朋友</b><span className="muted small">每位 +{me.subscription ? 60 : 30} 點</span><span className="gal-arr">›</span>
        </a>
        {/* 作品庫 is one place (finished videos); the list below is the working projects. */}
        <a className={`gal-link ${view === 'gallery' ? 'active' : ''}`} onClick={() => { setView('gallery'); setMenu(false) }}>
          <span className="gal-ic" aria-hidden="true">▣</span><b>作品庫</b><span className="muted small">{(() => { const f = projects.filter(p => p.final_version != null).length; const w = projects.filter(p => p.final_version == null && (p.exports ?? 0) > 0).length; return w ? `${f} 支完成 · ${w} 支進行中` : `已完成 ${f} 支` })()}</span><span className="gal-arr">›</span>
        </a>
        <div className="proj-sec">
          <span className="proj-sec-t">專案<small>{projects.length}</small></span>
          <button className="btn primary small" onClick={() => newProject()}>＋ 新專案</button>
        </div>
        <nav aria-label="專案">
          {projects.length === 0 && <span className="muted small" style={{ padding: '6px 10px' }}>還沒有專案，按上面「＋ 新專案」開始。</span>}
          {projects.map(p => (
            <a key={p.id} className={p.id === current && view === 'chat' ? 'active' : ''} onClick={() => openProject(p.id)}>
              <i className={`pj-dot ${p.final_version != null ? 'done' : ''}`} aria-hidden="true" />
              <span className="pj-name">{p.name}</span>
              {p.id === me.free_project_id && <span className="tag">免費</span>}
              {(notes?.by_project[p.id] ?? 0) > 0 && <span className="fb-badge" title="朋友的新反饋">{notes!.by_project[p.id]}</span>}
            </a>
          ))}
        </nav>
        <div className="me">
          <div className="mode-sw" role="radiogroup" aria-label="介面模式">
            <a role="radio" aria-checked={easy} className={easy ? 'on' : ''} onClick={() => setMode('easy')}>輕鬆模式</a>
            <a role="radio" aria-checked={!easy} className={!easy ? 'on' : ''} onClick={() => setMode('pro')}>導演模式</a>
          </div>
          <div className="muted small mode-hint">{easy ? '只看結論、少按幾下' : '看全部細節、每一步都能調'}</div>
          {me.is_admin && <a className="small" href="/dashboard">管理後台 ↗</a>}
          <div className="muted small">{me.email}</div>
          <a className="small" onClick={() => api.logout().then(() => setMe(null))}>登出</a>
        </div>
      </aside>

      <main className="main">
        {payOrder ? <PayResult orderId={payOrder} onDone={() => { setPayOrder(null); history.replaceState(null, '', '/'); refreshMe() }} />
          : view === 'gallery' ? <Gallery onOpen={openProject} />
          : view === 'credits' ? <Credits key={creditsTab + me.balance} initialTab={creditsTab} needPoints={needPoints} onClose={() => { setView('chat'); refreshMe() }} onOpenProject={openProject} onBought={refreshMe} />
          : current ? <Chat key={current} easy={easy} onMode={setMode} projectId={current} name={currentName} onUsage={refreshMe} onTopUp={need => showCredits(me.subscription ? 'buy' : 'plans', need)} onCredits={() => showCredits()} onStorage={() => showCredits('storage')}
              onProjectsChanged={() => api.projects().then(setProjects)} feedbackUnread={notes?.by_project[current] ?? 0} onFeedbackRead={pollNotes} />
            : <div className="first">
                <div className="first-card v3">
                  <span className="first-mark" aria-hidden="true"><IcPlay size={22} /></span>
                  <h2>做第一支影片</h2>
                  <p className="muted">丟素材，15 分鐘拿到成品。先取個名字就好。</p>
                  <button className="btn primary lg block first-go" onClick={() => newProject()}>建立第一個專案<i aria-hidden="true">→</i></button>
                  <div className="muted small first-hint">註冊送的點數夠做第一支，含封面和 2 輪修改</div>
                  <div className="first-row">{FIRST_KINDS.slice(0, 4).map(k => <a key={k.name} className="chipbtn" onClick={() => newProject(k.name)}>{k.name}</a>)}</div>
                </div>
              </div>}
      </main>
    </div>
  )
}
