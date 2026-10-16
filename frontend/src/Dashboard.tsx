import { useEffect, useMemo, useState } from 'react'
import { api, type Costs, type Order, type AdminUser, type AdminUserDetail, type Dashboard, type DashRow, type Me, type Stage } from './api'
import logo from './assets/logo.png'
import { MiaoMark } from './Logo'
import { ask } from './Dialog'

/* 管理後台 / CRM. Served at /dashboard on the app host and as the whole page on dashboard.editor.lakeze.com. */

const twd = (n: number) => `NT$${Math.round(n).toLocaleString()}`
const pct = (a: number, b: number) => (b ? Math.round((a - b) / b * 100) : a ? 100 : 0)
const day = (s?: string | null) => (s ? s.slice(0, 10) : '—')
const ago = (s?: string | null) => {
  if (!s) return '從未'
  const d = (Date.now() - Date.parse(s)) / 864e5
  return d < 1 ? '今天' : d < 2 ? '昨天' : d < 30 ? `${Math.floor(d)} 天前` : d < 365 ? `${Math.floor(d / 30)} 個月前` : `${Math.floor(d / 365)} 年前`
}
const STAGE_ORDER: Stage[] = ['sub', 'paid', 'churn', 'trial_done', 'trial', 'new', 'disabled']
const STAGE_CLS: Record<Stage, string> = { sub: 'sub', paid: 'paid', churn: 'churn', trial_done: 'done', trial: 'trial', new: 'new', disabled: 'off' }
const PROVIDER = { google: 'G', facebook: 'f', '': '@' } as Record<string, string>

export function DashboardApp({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<'overview' | 'users' | 'orders'>(location.pathname.endsWith('/users') ? 'users' : 'overview')
  const [days, setDays] = useState(30)
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [costsOpen, setCostsOpen] = useState(false)
  const reloadUsers = () => api.admin.users().then(setUsers)
  useEffect(() => { api.admin.dashboard(days).then(setDash) }, [days])
  useEffect(() => { reloadUsers() }, [])
  const appHome = location.hostname.startsWith('dashboard.') ? `https://${location.hostname.replace(/^dashboard\./, '')}/` : '/'
  return (
    <div className="dash">
      <header className="dash-top">
        <MiaoMark size={26} radius={.26} />
        <span className="dash-title">旅剪 管理後台 <small>CRM</small></span>
        <img className="logo dash-by" src={logo} alt="Lakeze" />
        <nav className="dnav">
          <a className={tab === 'overview' ? 'on' : ''} onClick={() => setTab('overview')}>總覽</a>
          <a className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>用戶 {users.length ? <span className="cnt">{users.length}</span> : null}</a>
          <a className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>訂單</a>
        </nav>
        {tab === 'overview' && (
          <div className="dnav mini">{[7, 30, 90].map(d => <a key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} 天</a>)}</div>
        )}
        <span className="spacer" />
        <a className="small" href={appHome}>回到剪輯 App</a>
        <span className="muted small">{me.email}</span>
        <a className="small" onClick={onLogout}>登出</a>
      </header>
      <main className="dash-main">
        {tab === 'overview' && (dash ? <Overview d={dash} onOpen={setOpenId} onCosts={() => setCostsOpen(true)} /> : <div className="center muted">載入中…</div>)}
        {tab === 'users' && <Users users={users} stages={dash?.stages} onOpen={setOpenId} />}
        {tab === 'orders' && <Orders onOpen={setOpenId} onChanged={() => { reloadUsers(); api.admin.dashboard(days).then(setDash) }} />}
      </main>
      {costsOpen && <CostDrawer days={days} onClose={() => setCostsOpen(false)} onOpenUser={id => { setCostsOpen(false); setOpenId(id) }} />}
      {openId && <UserDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => { reloadUsers(); api.admin.dashboard(days).then(setDash) }} />}
    </div>
  )
}

/* ---------------- overview ---------------- */
function Overview({ d, onOpen, onCosts }: { d: Dashboard; onOpen: (id: string) => void; onCosts: () => void }) {
  const p = d.period, q = d.previous, t = d.totals
  const maxRev = Math.max(1, ...d.daily.map(x => x.revenue_twd))
  const maxPts = Math.max(1, ...d.daily.map(x => Math.max(x.points_used + x.points_waived, x.cost_twd / d.point_twd)))
  const tierTotal = Math.max(1, d.tiers.free + d.tiers.payg + d.tiers.sub5 + d.tiers.sub15)
  const catMax = Math.max(1, ...d.by_category.map(c => c.points))
  return (
    <>
      <section className="dkpi-grid">
        <Kpi label="用戶" v={t.users} sub={`${d.days} 天新增 ${p.signups}`} delta={pct(p.signups, q.signups)} />
        <Kpi label="活躍用戶" v={p.active_users ?? 0} sub={`${d.days} 天內有送出訊息`} />
        <Kpi label="付費用戶" v={t.paying_users} sub={`轉換率 ${t.conversion_pct}% · 本期 ${p.buyers} 人購買`} />
        <Kpi label="訂閱中" v={t.subscribers} sub={`MRR ${twd(t.mrr_twd)}`} />
        <Kpi label={`${d.days} 天營收`} v={twd(p.revenue_twd)} sub={`累積 ${twd(t.revenue_twd)}`} delta={pct(p.revenue_twd, q.revenue_twd)} />
        <Kpi label={`${d.days} 天點數消耗`} v={`${p.points_used.toLocaleString()} 點`} sub={`免費額度 ${p.points_waived} 點 · 售出 ${p.points_sold} 送出 ${p.points_granted}`} delta={pct(p.points_used, q.points_used)} />
        <Kpi label={`${d.days} 天成本（API＋主機）`} v={twd(p.cost_twd)} sub={p.margin_pct == null ? '尚無成本' : `毛利率（對成本）${p.margin_pct}%`} delta={pct(p.cost_twd, q.cost_twd)} bad onClick={onCosts} />
        <Kpi label={`${d.days} 天影片輸出`} v={p.exports} sub={`累積 ${t.exports} 支 · 未用點數 ${t.points_outstanding.toLocaleString()} 點`} delta={pct(p.exports, q.exports)} />
      </section>
      <section className="dash-row two">
        <div className="card chart">
          <div className="chart-h"><b>每日營收</b><span className="muted small">柱＝儲值 NT$ · 點＝新註冊</span></div>
          <Bars rows={d.daily.map(x => ({ k: x.date, a: x.revenue_twd, dot: x.signups }))} max={maxRev} fmt={twd} color="var(--brand)" />
        </div>
        <div className="card chart">
          <div className="chart-h"><b>每日點數消耗 vs API 成本</b><span className="muted small">橘＝消耗點數（含免費） · 灰＝成本換算點數</span></div>
          <Bars rows={d.daily.map(x => ({ k: x.date, a: x.points_used + x.points_waived, b: x.cost_twd / d.point_twd }))} max={maxPts} fmt={n => `${Math.round(n)} 點`} color="var(--brand-2)" color2="#B7BCC6" />
        </div>
      </section>
      <section className="dash-row three">
        <div className="card">
          <div className="chart-h"><b>轉換漏斗</b><span className="muted small">全部用戶</span></div>
          <div className="funnel">
            {d.funnel.map((f, i) => (
              <div key={f.label} className="fn-row">
                <span className="fn-label">{f.label}</span>
                <span className="fn-bar"><i style={{ width: `${Math.max(2, f.n / Math.max(1, d.funnel[0].n) * 100)}%` }} /></span>
                <b>{f.n}</b><small className="muted">{i ? `${Math.round(f.n / Math.max(1, d.funnel[i - 1].n) * 100)}%` : ''}</small>
              </div>))}
          </div>
        </div>
        <div className="card">
          <div className="chart-h"><b>用戶分級</b><span className="muted small">目前</span></div>
          <div className="tier-bar">
            {(['free', 'payg', 'sub5', 'sub15'] as const).map(k => d.tiers[k] > 0 && <i key={k} className={k} style={{ width: `${d.tiers[k] / tierTotal * 100}%` }} />)}
          </div>
          <ul className="tier-legend">
            {([['free', '背包客（免費）'], ['payg', '旅行者（單次）'], ['sub5', '專業旅人'], ['sub15', '超級玩家']] as const).map(([k, l]) => (
              <li key={k}><i className={k} />{l}<b>{d.tiers[k]}</b><small className="muted">{Math.round(d.tiers[k] / tierTotal * 100)}%</small></li>))}
            {d.tiers.disabled > 0 && <li><i className="off" />停用<b>{d.tiers.disabled}</b></li>}
          </ul>
        </div>
        <div className="card">
          <div className="chart-h"><b>點數花在哪</b><span className="muted small">{d.days} 天</span></div>
          <div className="cat-bars">
            {d.by_category.map(c => (
              <div key={c.id} className="cat-row"><span>{c.label}</span><span className="fn-bar"><i style={{ width: `${c.points / catMax * 100}%` }} /></span><b>{c.points}</b></div>))}
          </div>
        </div>
      </section>
      <section className="dash-row four">
        <List title="快沒點的活躍用戶" hint="7 天內活躍、餘額 < 20 點、非訂閱" rows={d.low_balance} col={r => `${r.balance} 點`} onOpen={onOpen} stages={d.stages} empty="沒有，很好" />
        <List title="流失風險" hint="付費過、30 天沒活動" rows={d.churn} col={r => `儲值 ${twd(r.paid_twd)}`} onOpen={onOpen} stages={d.stages} empty="沒有流失風險" />
        <List title={`${d.days} 天消耗最多`} hint="含免費額度" rows={d.top} col={r => `${r.points_used} 點`} onOpen={onOpen} stages={d.stages} empty="還沒有人用" />
        <List title="最新註冊" hint="最近 8 位" rows={d.recent} col={r => ago(r.last_active)} onOpen={onOpen} stages={d.stages} empty="—" />
      </section>
    </>
  )
}

function Kpi({ label, v, sub, delta, bad, onClick }: { label: string; v: number | string; sub: string; delta?: number; bad?: boolean; onClick?: () => void }) {
  const good = delta === undefined ? null : bad ? delta <= 0 : delta >= 0
  return (
    <div className={`dkpi card ${onClick ? 'click' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined}>
      {onClick && <span className="dkpi-more">看明細 →</span>}
      <span className="muted small">{label}</span>
      <b>{typeof v === 'number' ? v.toLocaleString() : v}</b>
      <span className="dkpi-sub">{delta !== undefined && <em className={good ? 'up' : 'down'}>{delta > 0 ? '+' : ''}{delta}%</em>}<span className="muted small">{sub}</span></span>
    </div>
  )
}

function Bars({ rows, max, fmt, color, color2 }: { rows: { k: string; a: number; b?: number; dot?: number }[]; max: number; fmt: (n: number) => string; color: string; color2?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 600, H = 150, pad = 4
  const bw = (W - pad * 2) / rows.length
  const h = rows[hover ?? -1]
  return (
    <div className="dbars" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {rows.map((r, i) => {
          const x = pad + i * bw
          const ha = r.a / max * (H - 20), hb = (r.b ?? 0) / max * (H - 20)
          return (
            <g key={r.k} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={0} width={bw} height={H} fill="transparent" />
              {r.b !== undefined && <rect x={x + bw * 0.5} y={H - hb} width={bw * 0.35} height={hb} fill={color2} rx={1} />}
              <rect x={x + bw * 0.15} y={H - ha} width={r.b !== undefined ? bw * 0.35 : bw * 0.7} height={ha} fill={color} rx={1} opacity={hover === null || hover === i ? 1 : .55} />
              {r.dot ? <circle cx={x + bw / 2} cy={Math.min(H - ha - 8, H - 10)} r={Math.min(6, 2.5 + r.dot)} fill="var(--blue)" /> : null}
            </g>)
        })}
      </svg>
      <div className="dbars-x muted small"><span>{rows[0]?.k.slice(5)}</span><span>{h ? `${h.k} · ${fmt(h.a)}${h.b !== undefined ? ` / ${fmt(h.b)}` : ''}${h.dot ? ` · 新註冊 ${h.dot}` : ''}` : ''}</span><span>{rows[rows.length - 1]?.k.slice(5)}</span></div>
    </div>
  )
}

function List({ title, hint, rows, col, onOpen, stages, empty }: { title: string; hint: string; rows: DashRow[]; col: (r: DashRow) => string; onOpen: (id: string) => void; stages: Record<Stage, string>; empty: string }) {
  return (
    <div className="card dl">
      <div className="chart-h"><b>{title}</b><span className="muted small">{hint}</span></div>
      {rows.length === 0 && <div className="muted small">{empty}</div>}
      {rows.map(r => (
        <a key={r.id} className="dl-row" onClick={() => onOpen(r.id)}>
          <span className="dl-main"><span className="dl-email">{r.email}</span><span className={`stage ${STAGE_CLS[r.stage]}`}>{stages[r.stage]}</span></span>
          <b>{col(r)}</b>
        </a>))}
    </div>
  )
}

/* ---------------- users (CRM table) ---------------- */
type SortKey = 'created_at' | 'last_active' | 'balance' | 'paid_twd' | 'used_points' | 'exports' | 'cost_twd'
function Users({ users, stages, onOpen }: { users: AdminUser[]; stages?: Record<Stage, string>; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [stage, setStage] = useState<Stage | 'all'>('all')
  const [sort, setSort] = useState<SortKey>('created_at')
  const [dir, setDir] = useState<1 | -1>(-1)
  const st = stages ?? { sub: '訂閱中', paid: '付費用戶', churn: '流失風險', trial_done: '做過影片未付費', trial: '試用中', new: '註冊未使用', disabled: '停用' }
  const counts = useMemo(() => users.reduce((m, u) => ({ ...m, [u.stage]: (m[u.stage] ?? 0) + 1 }), {} as Record<string, number>), [users])
  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return users
      .filter(u => stage === 'all' || u.stage === stage)
      .filter(u => !ql || u.email.includes(ql) || (u.name ?? '').toLowerCase().includes(ql) || u.tags.some(t => t.toLowerCase().includes(ql)) || u.note.toLowerCase().includes(ql))
      .sort((a, b) => { const x = a[sort] ?? '', y = b[sort] ?? ''; return (x < y ? -1 : x > y ? 1 : 0) * dir })
  }, [users, q, stage, sort, dir])
  const th = (k: SortKey, label: string) => (
    <th className={`r sortable ${sort === k ? 'on' : ''}`} onClick={() => { if (sort === k) setDir(d => (d === 1 ? -1 : 1)); else { setSort(k); setDir(-1) } }}>{label}{sort === k ? (dir === -1 ? ' ↓' : ' ↑') : ''}</th>)
  const sumPaid = rows.reduce((a, u) => a + u.paid_twd, 0), sumBal = rows.reduce((a, u) => a + u.balance, 0), sumUsed = rows.reduce((a, u) => a + u.used_points, 0)
  return (
    <>
      <section className="crm-bar">
        <input placeholder="搜尋 email、名稱、標籤、備註" value={q} onChange={e => setQ(e.target.value)} />
        <div className="chips inline">
          <a className={`chipbtn ${stage === 'all' ? 'on' : ''}`} onClick={() => setStage('all')}>全部 {users.length}</a>
          {STAGE_ORDER.filter(s => counts[s]).map(s => <a key={s} className={`chipbtn ${stage === s ? 'on' : ''}`} onClick={() => setStage(s)}>{st[s]} {counts[s]}</a>)}
        </div>
        <a className="btn small" href={api.admin.csvUrl(q)}>匯出 CSV</a>
      </section>
      <div className="crm-sum muted small">{rows.length} 位用戶 · 累積儲值 <b>{twd(sumPaid)}</b> · 已用 <b>{sumUsed.toLocaleString()} 點</b> · 餘額合計 <b>{sumBal.toLocaleString()} 點</b></div>
      <div className="card crm-table">
        <table>
          <thead><tr><th>用戶</th><th>階段</th>{th('balance', '餘額')}{th('paid_twd', '累積儲值')}{th('used_points', '已用點')}{th('exports', '影片 / 專案')}{th('cost_twd', 'API 成本')}{th('created_at', '註冊')}{th('last_active', '最近活動')}</tr></thead>
          <tbody>
            {rows.map(u => (
              <tr key={u.id} onClick={() => onOpen(u.id)}>
                <td>
                  <div className="u-cell">
                    <span className={`avatar ${u.provider || 'email'}`}>{PROVIDER[u.provider] ?? '@'}</span>
                    <span className="u-main">
                      <span className="u-email">{u.email}{u.is_admin && <span className="tag">admin</span>}{u.subscription && <span className="tag sub">{u.subscription === 'sub15' ? '超級玩家' : '專業旅人'}</span>}{u.voice && <span className="tag">自己的聲音</span>}{u.referred_by && <span className="tag ref" title={`經 ${u.referred_by} 的分享頁註冊`}>朋友推薦</span>}</span>
                      <span className="muted small">{u.name ? `${u.name} · ` : ''}{u.tags.map(t => <em key={t} className="utag">{t}</em>)}{u.note && <span className="u-note">{u.note}</span>}</span>
                    </span>
                  </div>
                </td>
                <td><span className={`stage ${STAGE_CLS[u.stage]}`}>{st[u.stage]}</span></td>
                <td className={`r ${u.balance < 20 && u.stage !== 'new' ? 'low' : ''}`}>{u.balance}</td>
                <td className="r">{u.paid_twd ? twd(u.paid_twd) : <span className="muted">—</span>}{u.purchases > 1 && <small className="muted"> ×{u.purchases}</small>}</td>
                <td className="r">{u.used_points}{u.waived > 0 && <small className="muted"> 免{u.waived}</small>}</td>
                <td className="r">{u.exports} / {u.projects}</td>
                <td className="r muted">{u.cost_twd ? twd(u.cost_twd) : '—'}</td>
                <td className="r muted small">{day(u.created_at)}</td>
                <td className="r small">{ago(u.last_active)}</td>
              </tr>))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 30 }}>沒有符合的用戶</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ---------------- user drawer ---------------- */
function UserDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [u, setU] = useState<AdminUserDetail | null>(null)
  const [msgs, setMsgs] = useState<{ role: string; text?: string; tool?: string }[] | null>(null)
  const [tagIn, setTagIn] = useState('')
  const load = () => api.admin.user(id).then(setU)
  useEffect(() => { setU(null); setMsgs(null); load() }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const patch = async (body: Record<string, unknown>) => { await api.admin.patch(id, body); load(); onChanged() }
  const grant = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget)
    await api.admin.grant(id, Number(f.get('delta')), String(f.get('reason') || 'manual'), Number(f.get('twd') || 0))
    e.currentTarget.reset(); load(); onChanged()
  }
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const stages: Record<Stage, string> = { sub: '訂閱中', paid: '付費用戶', churn: '流失風險', trial_done: '做過影片未付費', trial: '試用中', new: '註冊未使用', disabled: '停用' }
  const maxD = u ? Math.max(1, ...u.daily.map(x => x.points)) : 1
  const catMax = u ? Math.max(1, ...u.by_category.map(c => c.points)) : 1
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer">
        {!u ? <div className="center muted">載入中…</div> : (
          <>
            <div className="dr-head">
              <div>
                <div className="dr-email">{u.email}{u.is_admin && <span className="tag">admin</span>}</div>
                <div className="muted small">{u.name ? `${u.name} · ` : ''}{u.provider ? `${u.provider === 'google' ? 'Google' : 'Facebook'} 登入` : 'Email 登入'} · 註冊 {day(u.created_at)} · 最近活動 {ago(u.last_active)}{u.referred_by ? ` · 經 ${u.referred_by} 推薦` : ''}{u.referred?.length ? ` · 推薦了 ${u.referred.length} 人` : ''}</div>
              </div>
              <span className={`stage ${STAGE_CLS[u.stage]}`}>{stages[u.stage]}</span>
              <a className="dr-close" onClick={onClose}>✕</a>
            </div>
            <div className="dr-tags">
              {u.tags.map(t => <em key={t} className="utag">{t}<a onClick={() => patch({ tags: u.tags.filter(x => x !== t) })}>×</a></em>)}
              <input placeholder="＋ 標籤（Enter）" value={tagIn} onChange={e => setTagIn(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && tagIn.trim()) { patch({ tags: [...u.tags, tagIn.trim()] }); setTagIn('') } }} />
            </div>
            <div className="dr-kpis">
              <div><span className="muted small">累積儲值</span><b>{twd(u.summary.paid_twd)}</b><small className="muted">{u.summary.purchases} 次</small></div>
              <div><span className="muted small">餘額</span><b>{u.summary.balance} 點</b><small className="muted">買 {u.summary.purchased_points} · 送 {u.summary.granted_points}</small></div>
              <div><span className="muted small">已用點數</span><b>{u.summary.used_points}</b><small className="muted">免費 {u.summary.waived_points}{u.summary.expired_points ? ` · 到期 ${u.summary.expired_points}` : ''}</small></div>
              <div><span className="muted small">API 成本</span><b>{twd(u.summary.cost_twd)}</b><small className="muted">US${u.summary.cost_usd}</small></div>
              <div className={u.summary.profit_twd >= 0 ? 'good' : 'bad'}><span className="muted small">毛利</span><b>{twd(u.summary.profit_twd)}</b><small className="muted">{u.summary.margin_pct == null ? '—' : `${u.summary.margin_pct}%`}</small></div>
              <div><span className="muted small">影片</span><b>{u.summary.exports} 支</b><small className="muted">修改 {u.summary.revision_turns} 輪</small></div>
            </div>
            <div className="dr-two">
              <div className="card">
                <div className="chart-h"><b>30 天點數</b><span className="muted small">含免費額度</span></div>
                <div className="spark">{u.daily.map(x => <i key={x.date} title={`${x.date} ${x.points} 點`} style={{ height: `${Math.max(2, x.points / maxD * 100)}%` }} />)}</div>
              </div>
              <div className="card">
                <div className="chart-h"><b>花在哪</b><span className="muted small">全部期間</span></div>
                <div className="cat-bars small">
                  {u.by_category.filter(c => c.points).map(c => <div key={c.id} className="cat-row"><span>{c.label}</span><span className="fn-bar"><i style={{ width: `${c.points / catMax * 100}%` }} /></span><b>{c.points}</b></div>)}
                  {u.by_category.every(c => !c.points) && <div className="muted small">還沒用過</div>}
                </div>
              </div>
            </div>
            <div className="card dr-sec">
              <b>方案與空間</b>
              <div className="muted small">
                {u.subscription ? `訂閱 ${u.subscription === 'sub15' ? '超級玩家' : '專業旅人'} · 本期 ${day(u.sub_period_start)} 起 · ${day(u.sub_renews_at)} 續約` : '沒有訂閱'} · 空間 {u.storage_plan}
                {' '}已用 {(u.storage_bytes / 2 ** 30).toFixed(2)} / {u.storage_quota_bytes < 2 ** 30 ? `${Math.round(u.storage_quota_bytes / 2 ** 20)} MB` : `${Math.round(u.storage_quota_bytes / 2 ** 30)} GB`}
                {u.voice ? ` · 自己的聲音「${u.voice.name ?? ''}」${u.voice_trial_seconds ? `（試用已生成 ${u.voice_trial_seconds} 秒）` : ''}` : ''}
              </div>
              <form className="row" onSubmit={grant}>
                <input name="delta" type="number" placeholder="點數 (+/−)" required style={{ width: 110 }} />
                <input name="twd" type="number" placeholder="實收 NT$（選填）" style={{ width: 140 }} />
                <input name="reason" placeholder="備註，如：轉帳 10/14" style={{ flex: 1, minWidth: 140 }} />
                <button className="btn primary small">加點</button>
              </form>
              <form className="row" onSubmit={async e => {
                e.preventDefault(); const f = new FormData(e.currentTarget); const plan = String(f.get('plan'))
                if (!await ask.confirm(plan ? `開通／續約 ${plan}？會入帳該方案的點數並綁定空間。` : '結束訂閱？剩餘的訂閱點數會到期，空間降回免費。')) return
                await api.admin.subscription(id, plan, Number(f.get('subtwd') || 0)); load(); onChanged()
              }}>
                <select name="plan" defaultValue={u.subscription || 'sub5'}>
                  <option value="sub5">專業旅人（5 支／月）</option><option value="sub15">超級玩家（15 支／月）</option><option value="">結束訂閱</option>
                </select>
                <input name="subtwd" type="number" placeholder="實收 NT$" style={{ width: 110 }} />
                <button className="btn small">{u.subscription ? '續約／變更' : '開通訂閱'}</button>
                <input type="number" placeholder="空間上限 GB（0=依方案）" defaultValue={u.storage_quota_gb ?? ''} style={{ width: 170 }}
                  onBlur={e => { const v = Number(e.target.value || 0); if (v !== (u.storage_quota_gb ?? 0)) patch({ storage_quota_gb: v }) }} />
              </form>
              <div className="row">
                <button className="btn small" onClick={() => patch({ disabled: !u.disabled })}>{u.disabled ? '啟用帳號' : '停用帳號'}</button>
                <button className="btn small" onClick={() => patch({ is_admin: !u.is_admin })}>{u.is_admin ? '取消管理員' : '設為管理員'}</button>
                <button className="btn small" onClick={async () => { if (await ask.confirm('重設免費專案？下一個新專案會再次免費。')) patch({ reset_free_project: true }) }}>再送一次免費專案</button>
              </div>
              <textarea rows={2} placeholder="CRM 備註（來源、聯絡紀錄、需求…）" defaultValue={u.note} onBlur={e => e.target.value !== u.note && patch({ note: e.target.value })} />
            </div>
            <div className="card dr-sec">
              <b>專案 <span className="muted small">{u.projects.length}</span></b>
              <table>
                <tbody>{u.projects.map(p => (
                  <tr key={p.id}>
                    <td>{p.name}{p.free && <span className="tag">免費</span>}{p.final_version != null && <span className="tag">已交付 v{p.final_version}</span>}</td>
                    <td className="r muted small">輸出 {p.exports} · 修改 {p.revision_turns} 輪</td>
                    <td className="r muted small">{twd(p.cost_usd * 32)}</td>
                    <td className="r muted small">{ago(p.updated_at)}</td>
                    <td className="r"><a className="small" onClick={() => api.admin.messages(p.id).then(setMsgs)}>對話</a></td>
                  </tr>))}
                  {u.projects.length === 0 && <tr><td className="muted small">還沒建立專案</td></tr>}
                </tbody>
              </table>
              {msgs && <div className="log">{msgs.map((m, i) => <div key={i} className={m.role}>{m.tool ? `🔧 ${m.tool}` : m.text}</div>)}<a className="small" onClick={() => setMsgs(null)}>收起</a></div>}
            </div>
            <div className="card dr-sec">
              <b>點數與儲值紀錄 <span className="muted small">{u.ledger.length}</span></b>
              <table>
                <tbody>{u.ledger.map(l => (
                  <tr key={l.id} className={l.kind}>
                    <td className="muted small">{(l.created_at ?? '').slice(0, 16).replace('T', ' ')}</td>
                    <td><span className={`lk ${l.kind}`}>{({ purchase: '儲值', grant: '贈送', charge: '扣點', refund: '退點', expire: '到期' } as Record<string, string>)[l.kind] ?? l.kind}</span> {l.reason}{l.meta?.test ? <span className="tag">測試</span> : null}</td>
                    <td className="r">{l.delta > 0 ? '+' : ''}{l.delta}{l.waived ? <small className="muted"> 免 {l.waived}</small> : ''}</td>
                    <td className="r muted">{l.amount_twd ? twd(l.amount_twd) : ''}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          </>
        )}
      </aside>
    </>
  )
}

/* ---------------- orders ---------------- */
const ORDER_ST: Record<string, string> = { pending: '待付款', reported: '待確認轉帳', paid: '已付款', failed: '失敗／退回', cancelled: '已取消' }
function Orders({ onOpen, onChanged }: { onOpen: (id: string) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Order[] | null>(null)
  const [st, setSt] = useState('reported')
  const load = () => api.admin.orders(st).then(setRows)
  useEffect(() => { setRows(null); load() }, [st]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (fn: () => Promise<unknown>) => { await fn(); load(); onChanged() }
  return (
    <>
      <section className="crm-bar">
        <div className="chips inline">{[['reported', '待確認轉帳'], ['pending', '待付款'], ['paid', '已付款'], ['', '全部']].map(([k, l]) => <a key={k} className={`chipbtn ${st === k ? 'on' : ''}`} onClick={() => setSt(k)}>{l}</a>)}</div>
      </section>
      <div className="card crm-table">
        <table>
          <thead><tr><th>時間</th><th>用戶</th><th>品項</th><th className="r">金額</th><th>方式</th><th>狀態</th><th>末五碼</th><th></th></tr></thead>
          <tbody>
            {rows === null && <tr><td colSpan={8} className="muted">載入中…</td></tr>}
            {rows?.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 24 }}>沒有訂單</td></tr>}
            {rows?.map(o => (
              <tr key={o.id}>
                <td className="muted small">{o.created_at.slice(0, 16).replace('T', ' ')}</td>
                <td><a onClick={() => o.user_id && onOpen(o.user_id)}>{o.email}</a></td>
                <td>{o.label}<span className="muted small"> · {o.points} 點</span></td>
                <td className="r">{twd(o.amount_twd)}</td>
                <td className="small">{({ card: '信用卡', transfer: '轉帳', test: '測試' } as Record<string, string>)[o.method] ?? o.method}</td>
                <td><span className={`stage ${o.status === 'paid' ? 'paid' : o.status === 'reported' ? 'done' : o.status === 'pending' ? 'trial' : 'off'}`}>{ORDER_ST[o.status]}</span></td>
                <td className="small">{o.transfer_ref || '—'}</td>
                <td className="r">{(o.status === 'reported' || o.status === 'pending') && <span className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn small primary" onClick={async () => { if (await ask.confirm(`確認已收到 ${twd(o.amount_twd)}，入帳 ${o.label}？`)) act(() => api.admin.approveOrder(o.id)) }}>確認入帳</button>
                  <button className="btn small" onClick={async () => { if (await ask.confirm('退回這筆訂單？', { ok: '退回', danger: true })) act(() => api.admin.rejectOrder(o.id)) }}>退回</button></span>}</td>
              </tr>))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ---------------- API 成本明細 ---------------- */
const nt = (n: number) => `NT$${n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(1)}`
function CostDrawer({ days: d0, onClose, onOpenUser }: { days: number; onClose: () => void; onOpenUser: (id: string) => void }) {
  const [days, setDays] = useState(d0)
  const [c, setC] = useState<Costs | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  useEffect(() => { setC(null); api.admin.costs(days).then(setC) }, [days])
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const maxDay = c ? Math.max(1, ...c.daily.map(x => c.groups.reduce((a, g) => a + Number(x[g.id] ?? 0), 0))) : 1
  const tk = c?.claude_tokens
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer cost-drawer">
        <div className="dr-head"><div><div className="dr-email">API 與主機成本明細</div><div className="muted small">點大項看細項 · 1 美元以 NT${c?.twd_per_usd ?? 32} 計</div></div>
          <div className="dnav mini">{[7, 30, 90].map(x => <a key={x} className={days === x ? 'on' : ''} onClick={() => setDays(x)}>{x} 天</a>)}</div><a className="dr-close" onClick={onClose}>✕</a></div>
        {!c ? <div className="center muted">載入中…</div> : (
          <>
            <div className="dr-kpis">
              <div><span className="muted small">總成本</span><b>{nt(c.twd)}</b><small className="muted">US${c.usd}</small></div>
              <div><span className="muted small">每支影片</span><b>{c.per_export_twd != null ? nt(c.per_export_twd) : '—'}</b><small className="muted">{c.exports} 次輸出</small></div>
              <div className={c.margin_pct != null && c.margin_pct >= 0 ? 'good' : 'bad'}><span className="muted small">營收 / 毛利率</span><b>{nt(c.revenue_twd)}</b><small className="muted">{c.margin_pct == null ? '—' : `${c.margin_pct}%`}</small></div>
            </div>
            <div className="cost-stack">{c.groups.filter(g => g.twd > 0).map(g => <i key={g.id} style={{ width: `${g.pct}%`, background: g.color }} title={`${g.label} ${g.pct}%`} />)}</div>
            <div className="cost-groups">
              {c.groups.map(g => {
                const isOpen = open[g.id] ?? true
                return (
                  <div key={g.id} className="cost-g card">
                    <button className="cg-head" onClick={() => setOpen(o => ({ ...o, [g.id]: !isOpen }))}>
                      <i className="cg-dot" style={{ background: g.color }} /><b>{g.label}</b><span className="muted small">{g.pct}%</span>
                      <span className="spacer" /><b className="cg-amt">{nt(g.twd)}</b><span className="cg-chev">{isOpen ? '▾' : '▸'}</span>
                    </button>
                    {isOpen && (
                      <div className="cg-items">
                        {g.items.length === 0 && <div className="muted small">這段期間沒有用到</div>}
                        {g.items.map(it => (
                          <div key={it.id} className="cg-item">
                            <div className="cgi-top"><span>{it.label}</span><b>{nt(it.twd)}</b></div>
                            <div className="cgi-bar"><i style={{ width: `${it.pct}%`, background: g.color }} /></div>
                            <div className="muted small">{Math.round(it.units).toLocaleString()} {it.unit}{g.id !== 'railway' && <> · {it.calls} 次</>} · 占{g.label.replace(/（.*）/, '')} {it.pct}%{it.calls ? ` · 平均每次 ${nt(it.twd / it.calls)}` : ''}</div>
                          </div>))}
                        {g.id === 'railway' && c.railway && (
                          <div className="cg-rw">
                            {c.railway.error && <div className="cg-rw-warn">{c.railway.error}</div>}
                            <div className="cg-rw-row"><span>本期資源用量（預估到週期結束）</span><b>{c.railway.month_estimate_usd != null ? `US$${c.railway.month_estimate_usd.toFixed(2)}` : '—'}</b></div>
                            <div className="cg-rw-row"><span>本期 Railway 帳單（預估）</span><b>US${c.railway.month_bill_usd.toFixed(2)}</b></div>
                            <div className="muted small">Railway 計費方式：Pro 方案月費 US${c.railway.plan_fee_usd} 已內含等額用量；超過才另外收。用量依分鐘計：CPU US$20／vCPU／月、記憶體 US$10／GB／月、對外流量 US$0.05／GB、硬碟 US$0.15／GB／月，建置不收費。這裡逐日計算：每天 = 當天實際用量 ＋ 當天分攤的「月費沒用完的部分」（依 Railway 帳單週期{c.railway.cycle_start ? `（${new Date(c.railway.cycle_start).toLocaleDateString('zh-TW')} 起）` : ''}按小時攤到每一天），一個週期的每日加總正好等於該期帳單。</div>
                          </div>)}
                        {g.id === 'claude' && tk && (tk.in + tk.out) > 0 && (
                          <div className="cg-tokens">
                            <div className="muted small">token 組成</div>
                            {[['輸入', tk.in, tk.usd_in], ['輸出', tk.out, tk.usd_out], ['快取讀取', tk.cache_read, tk.usd_cache_read], ['快取寫入', null, tk.usd_cache_write]].map(([l, n, v]) => (
                              <div key={l as string} className="cgt-row"><span>{l}</span><span className="muted small">{n != null ? `${(Number(n) / 1e6).toFixed(2)}M tokens` : ''}</span><b>{nt(Number(v))}</b></div>))}
                          </div>)}
                      </div>)}
                  </div>)
              })}
            </div>
            <div className="card">
              <div className="chart-h"><b>每日成本</b><span className="muted small">依大項堆疊</span></div>
              <div className="cost-daily">{c.daily.map(x => (
                <div key={x.date} className="cd-col" title={`${x.date} ${nt(c.groups.reduce((a, g) => a + Number(x[g.id] ?? 0), 0))}`}>
                  {c.groups.map(g => <i key={g.id} style={{ height: `${Number(x[g.id] ?? 0) / maxDay * 100}%`, background: g.color }} />)}
                </div>))}</div>
            </div>
            <div className="card dr-sec">
              <b>成本最高的專案</b>
              <table><tbody>{c.top_projects.map(p => (
                <tr key={p.id}><td>{p.name}<div className="muted small">{p.email}</div></td>
                  <td><div className="cost-mini">{c.groups.map(g => p.by_group[g.id] ? <i key={g.id} style={{ flex: p.by_group[g.id], background: g.color }} /> : null)}</div></td>
                  <td className="r"><b>{nt(p.twd)}</b></td></tr>))}
                {c.top_projects.length === 0 && <tr><td className="muted small">沒有資料</td></tr>}</tbody></table>
            </div>
            <div className="card dr-sec">
              <b>成本最高的用戶</b>
              <table><tbody>{c.top_users.map(u => <tr key={u.id} onClick={() => onOpenUser(u.id)} style={{ cursor: 'pointer' }}><td>{u.email}</td><td className="r"><b>{nt(u.twd)}</b></td></tr>)}</tbody></table>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
