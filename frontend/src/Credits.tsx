import { useEffect, useMemo, useState } from 'react'
import { PayFlow } from './Pay'
import { api, type CreditsSummary, type Ledger, type Me, type Pricing } from './api'
import { StorageInline } from './Storage'
import { ReferralCard } from './Referral'

// Fixed categorical order, validated for colour-vision separation on the light surface.
const CAT_COLOR: Record<string, string> = { cut: '#E95B17', audio: '#1B7AC3', subs: '#2E9E8F', export: '#7B61C4', cover: '#B8860B', storage: '#5B6B7A' }
export type CreditsTab = 'overview' | 'projects' | 'ledger' | 'plans' | 'buy' | 'storage' | 'referral'
const TABS: { id: CreditsTab; label: string }[] = [
  { id: 'plans', label: '選方案' }, { id: 'overview', label: '我的方案' }, { id: 'projects', label: '專案明細' }]
const twd = (n: number) => `NT$${n.toLocaleString()}`

export const fmtGB = (gb: number) => gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb} GB`

const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  return same(d, t) ? '今天' : same(d, y) ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`
}

export function Credits({ initialTab = 'plans', needPoints = 0, onClose, onOpenProject, onBought }:
  { initialTab?: CreditsTab; needPoints?: number; onClose: () => void; onOpenProject?: (id: string) => void; onBought?: () => void }) {
  const [tab, setTab] = useState<CreditsTab>(initialTab === 'storage' ? 'plans' : initialTab === 'ledger' ? 'projects' : initialTab === 'referral' ? 'overview' : initialTab)
  const [range, setRange] = useState<7 | 30>(30)
  const [sum, setSum] = useState<CreditsSummary | null>(null)
  const [p, setP] = useState<Pricing | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [nVideos, setNVideos] = useState(5)
  const [nRev, setNRev] = useState(1)
  const [amt, setAmt] = useState(String(needPoints > 0 ? Math.max(20, needPoints) : 100))   // 自訂儲值點數
  const reload = () => { api.creditsSummary().then(setSum); api.credits().then(r => setLedger(r.ledger)); api.me().then(setMe) }
  useEffect(() => { reload(); api.pricing().then(setP) }, [])
  useEffect(() => {
    if (initialTab === 'storage' && p) setTimeout(() => document.getElementById('storage-sec')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
    if (initialTab === 'referral' && p) setTimeout(() => document.getElementById('referral-sec')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250)
  }, [initialTab, p])
  const [toast, setToast] = useState('')
  const [paying, setPaying] = useState<string | null>(null)
  const buy = (id: string) => setPaying(id)
  const canBuy = (_url?: string | null) => true   // the payment flow shows which methods are open
  const label = (tool: string) => sum?.tool_labels[tool] ?? tool
  const cat = (tool: string) => {
    const m: Record<string, string> = { probe_footage: 'cut', sample_frames: 'cut', build_cut: 'cut', list_drive_folder: 'cut', download_footage: 'cut',
      search_voices: 'audio', generate_voice: 'audio', generate_music: 'audio', generate_sfx: 'audio', compose_audio: 'subs', render_captions: 'subs',
      preview_video: 'subs', revision_turn: 'subs', export_video: 'export', make_cover: 'cover', storage: 'storage' }
    return m[tool] ?? 'subs'
  }
  const projName = useMemo(() => Object.fromEntries((sum?.projects ?? []).map(x => [x.id, x.name])), [sum])

  if (!sum || !p) return <div className="center muted">載入中…</div>
  const FIRST = p.first_video_points, REV = p.revision_points
  const revisionsLeft = Math.floor(sum.balance / REV)
  const videosLeft = sum.balance / FIRST
  const low = sum.balance < 10
  const days = sum.daily.slice(-range)
  const dayTotal = (d: { used: number; waived: number }) => d.used + d.waived
  const rangeTotal = days.reduce((a, d) => a + dayTotal(d), 0)
  const activeDays = days.filter(d => dayTotal(d) > 0).length
  const peak = Math.max(0, ...days.map(dayTotal))
  const yTop = peak <= 10 ? 10 : Math.ceil(peak / (peak > 100 ? 50 : 10)) * (peak > 100 ? 50 : 10)   // a round top for the scale
  const peakAt = days.findIndex(d => dayTotal(d) === peak)
  const wk = ['日', '一', '二', '三', '四', '五', '六']
  // 成果: finished videos, revision rounds, and roughly what that saved against the usual way
  const S = p.savings ?? { video_twd: 3000, revision_twd: 600, video_min: 240, revision_min: 40, app_video_min: 15, app_revision_min: 3 }
  const doneVideos = sum.projects.filter(x => x.exports > 0).length
  const revRounds = sum.projects.reduce((a, x) => a + x.revision_turns, 0)
  const savedTwd = Math.max(0, doneVideos * S.video_twd + revRounds * S.revision_twd - Math.round(sum.used * p.point_twd))
  const savedHours = Math.max(0, doneVideos * (S.video_min - S.app_video_min) + revRounds * (S.revision_min - S.app_revision_min)) / 60
  const month = sum.daily.reduce((a, d) => a + d.used + d.waived, 0)
  const groupByDay = (rows: Ledger[]) => {
    const groups: { day: string; items: Ledger[] }[] = []
    for (const l of rows) {
      const day = dayLabel(l.created_at)
      const g = groups[groups.length - 1]
      if (g && g.day === day) g.items.push(l); else groups.push({ day, items: [l] })
    }
    return groups
  }
  const ledgerRow = (l: Ledger, i: number, showProject: boolean) => {
    const isCharge = l.kind === 'charge'
    const title = isCharge ? label(l.reason) : l.kind === 'purchase' ? '儲值' : l.kind === 'grant' ? (l.reason.startsWith('referral') ? '朋友做出第一支影片 · 推薦獎勵' : l.reason === 'signup' ? '註冊禮' : '加點') : l.kind === 'refund' ? '退點'
      : l.kind === 'subscription' ? '訂閱點數入帳' : l.kind === 'expire' ? '訂閱點數到期' : l.reason
    return (
      <div key={i} className="lrow">
        <i style={{ background: isCharge ? CAT_COLOR[cat(l.reason)] : l.kind === 'expire' ? '#C9C3B8' : 'var(--ok)' }} />
        <div className="lmain">
          <div>{title}</div>
          <div className="muted small">{showProject && l.project_id ? `${projName[l.project_id] ?? ''} ` : (!l.project_id && l.reason !== title && l.kind !== 'expire' ? `${l.reason} ` : '')}
            {new Date(l.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
        </div>
        <div className={`lamt ${l.delta > 0 ? 'ok' : ''}`}>
          {l.delta > 0 ? `+${l.delta}` : l.delta < 0 ? `−${-l.delta}` : <span className="muted">免 {l.waived}</span>}
        </div>
      </div>
    )
  }
  const dayGroups = (rows: Ledger[], showProject: boolean) => groupByDay(rows).map(g => (
    <div key={g.day} className="lgroup"><div className="lday muted small">{g.day}</div>{g.items.map((l, i) => ledgerRow(l, i, showProject))}</div>))
  const sub = me?.subscription ?? null
  const sub5 = p.subscriptions.find(s => s.id === 'sub5') ?? p.subscriptions[0]
  const single = p.first_video_twd + 2 * p.revision_twd   // one video with cover and 2 revision rounds, in NT$
  // top-up calculator
  const need = nVideos * FIRST + nVideos * nRev * REV
  const myPlan = sub ? p.subscriptions.find(x => x.id === sub.id) : undefined
  // 自訂儲值: any whole number of points from MIN; 1 點 at the plan's price while subscribed, 300 點起加送.
  const MIN = p.min_topup_points ?? 20, MAX = p.max_topup_points ?? 50000
  const rateOf = (plan?: string) => (plan ? p.subscriptions.find(x => x.id === plan)?.point_twd : undefined) ?? p.point_twd
  const bonusOf = (n: number) => Math.floor(n * (p.topup_bonus ?? []).reduce((r, b) => (n >= b.from ? Math.max(r, b.rate) : r), 0) + 1e-9)
  const topup = (n: number, plan = sub?.id) => { const r = rateOf(plan); const b = bonusOf(n); return { n, bonus: b, total: n + b, rate: r, twd: Math.floor(n * r + 0.5 + 1e-9) } }
  const topupFor = (want: number, plan = sub?.id) => {   // the smallest top-up that brings in at least `want` points
    let n = Math.max(MIN, Math.ceil(want / 1.2))
    while (n + bonusOf(n) < want) n++
    return topup(n, plan)
  }
  const amtN = parseInt(amt || '0', 10)
  const amtOk = amtN >= MIN && amtN <= MAX
  const cur = topup(amtOk ? amtN : Math.min(Math.max(amtN, MIN), MAX))
  // 試算比較: a month of `need` points bought single, or on each plan (the plan's points + top-ups at its price).
  const compare = [{ id: '', label: '單次購買', fee: 0, incl: 0 }, ...p.subscriptions.map(x => ({ id: x.id, label: x.label, fee: x.twd, incl: x.points }))].map(o => {
    const extra = Math.max(0, need - o.incl)
    const t = extra > 0 ? topupFor(extra, o.id || '') : null
    const cost = o.fee + (t?.twd ?? 0)
    const pts = o.incl + (t?.total ?? 0)
    return { ...o, cost, pts, rate: Math.round(cost / Math.max(1, pts) * 100) / 100, buy: t }
  })
  const cheapest = compare.reduce((a, o) => (o.cost < a.cost ? o : a), compare[0])
  const sugg = topupFor(needPoints > 0 ? needPoints : need)

  return (
    <div className="credits">
      {toast && <div className="buy-toast">{toast}</div>}
      {paying && p && (() => {
        const sb = p.subscriptions.find(x => x.id === paying)
        const tu = paying.startsWith('pts:') ? topup(parseInt(paying.slice(4), 10)) : null
        const item = tu ? { id: paying, kind: 'pack' as const, title: `${tu.n.toLocaleString()} 點${tu.bonus ? `（送 ${tu.bonus}，實得 ${tu.total.toLocaleString()} 點）` : ''}`, sub: `1 點 ${twd(tu.rate)}${myPlan ? `・${myPlan.label}價` : ''} · 約可剪 ${(tu.total / (p.first_video_points + 2 * p.revision_points)).toFixed(1)} 支`, points: tu.total, twd: tu.twd, listTwd: myPlan ? Math.floor(tu.n * p.point_twd + 0.5) : undefined }
          : sb ? { id: sb.id, kind: 'sub' as const, title: `${sb.label} · ${sb.billing === 'quarter' ? '季繳' : '月繳'}`, sub: sb.billing === 'quarter' ? `一次 3 個月：${sb.points.toLocaleString()} 點，每月約 ${sb.videos} 支 · ${sb.storage_gb} GB 空間` : `每月 ${sb.points} 點，約 ${sb.videos} 支 · ${sb.storage_gb} GB 空間`, points: sb.points, twd: sb.twd, listTwd: sb.payg_twd } : null
        return item && <PayFlow item={item} onClose={() => { setPaying(null); reload(); onBought?.() }} onPaid={() => { setPaying(null); setToast(`完成！${item.title}已入帳`); setTimeout(() => setToast(''), 5000); reload(); onBought?.() }} />
      })()}
      <header>
        <h2>點數與方案</h2>
        <div className="seg">
          {TABS.map(t => <a key={t.id} className={tab === t.id || (tab === 'buy' && t.id === 'plans') ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</a>)}
        </div>
        <a className="small back" onClick={onClose}>回到專案</a>
      </header>

      <div className="credits-body">
        {tab === 'overview' && (
          <>
            <section className={`hero card ${low ? 'low' : ''}`}>
              <div className="hero-main">
                <div className="hero-plan">目前方案<b>{sub ? sub.label : me?.tier === 'free' ? '免費方案' : '單次購買'}</b>{sub ? <span>包月 · 1 點 {twd(myPlan?.point_twd ?? 0)}</span> : <a onClick={() => setTab('plans')}>改包月更划算 →</a>}</div>
                <div className="eyebrow">目前餘額</div>
                <div className="hero-num">{sum.balance}<span className="unit">點</span></div>
                <div className="hero-sub">
                  {low ? '快用完了。' : ''}約可再做 <b>{Math.floor(videosLeft)}</b> 支影片{revisionsLeft > 0 && videosLeft < 1 ? <>，或改 <b>{revisionsLeft}</b> 輪</> : null}
                </div>
              </div>
              <div className="hero-side">
                <button className="btn primary" onClick={() => setTab(sub ? 'buy' : 'plans')}>{sub ? `用${sub.label}價儲值` : '儲值'}</button>
                <a className="small" onClick={() => setTab('plans')}>看方案</a>
              </div>
              <div className="hero-foot">
                {sub ? <>
                  <span>每月 <b>{sub.points}</b> 點{sub.renews_at && <> · {sub.renews_at.slice(5, 10).replace('-', '/')} 續約</>}</span>
                  <span className="dot-sep" /><span>點數累積不歸零</span>
                </> : <span>最近 30 天用了 <b>{month}</b> 點</span>}
                {sum.free_project && sum.free_project.in_free && <><span className="dot-sep" /><span>「{sum.free_project.name}」還有 <b>{sum.free_project.free_revisions_left ?? '免費'}</b> 輪免費修改</span></>}
              </div>
            </section>

            <ReferralCard onPlans={() => setTab('plans')} />

            <section className="card wins">
              <div className="wins-head"><b>你的成果</b><span className="muted small">用旅剪 TravelCut 到現在</span></div>
              <div className="wins-grid">
                <div><span>完成影片</span><b>{doneVideos}<small> 支</small></b></div>
                <div><span>修改</span><b>{revRounds}<small> 輪</small></b></div>
                <div className="hl"><span>大約省下</span><b>{twd(savedTwd)}</b></div>
                <div className="hl"><span>大約省下</span><b>{savedHours < 10 ? savedHours.toFixed(1) : Math.round(savedHours)}<small> 小時</small></b></div>
              </div>
              <div className="muted small wins-fine">以市場平均一支 {twd(S.video_twd)}、自己剪一支約 {S.video_min / 60} 小時估算，已扣掉你花的點數。</div>
            </section>

            <section className="card chart">
              <div className="chart-head">
                <div><b>每日用量</b><div className="muted small">{range} 天共 <b className="ink">{rangeTotal.toLocaleString()}</b> 點{activeDays > 0 && <>・有剪片的 {activeDays} 天平均 {Math.round(rangeTotal / activeDays)} 點</>}</div></div>
                <div className="seg mini">{([7, 30] as const).map(r => <a key={r} className={range === r ? 'on' : ''} onClick={() => { setRange(r); setHover(null) }}>{r} 天</a>)}</div>
              </div>
              {sum.daily.some(d => d.waived > 0) && <span className="legend"><span><i style={{ background: CAT_COLOR.cut }} />扣點</span><span><i className="hatch" />免費額度</span></span>}
              <div className={`plot2 r${range}`}>
                <div className="yax muted small"><span>{yTop}</span><span>{yTop / 2}</span><span>0</span></div>
                <div className="pane">
                  <div className="grid"><span /><span /><span /></div>
                  <div className="bars" role="img" aria-label={`最近 ${range} 天每日點數用量`} onMouseLeave={() => setHover(null)}>
                    {days.map((d, i) => {
                      const t = dayTotal(d)
                      const lab = t > 0 && (range === 7 || i === peakAt)
                      return (
                        <div key={d.date} className={`bar-col ${hover === i ? 'hover' : ''}`} onMouseEnter={() => setHover(i)} onClick={() => setHover(hover === i ? null : i)}>
                          {t > 0 ? (
                            <div className="bar-stack" style={{ height: `${(t / yTop) * 100}%` }}>
                              {lab && hover !== i && <em className="vlab">{t}</em>}
                              {d.waived > 0 && <div className="seg hatch" style={{ flex: d.waived }} />}
                              {d.used > 0 && <div className="seg" style={{ flex: d.used, background: CAT_COLOR.cut }} />}
                            </div>) : <div className="bar-nil" />}
                          {hover === i && <div className={`tip ${i < 3 ? 'l' : i > days.length - 4 ? 'r' : ''}`}>{d.date.slice(5).replace('-', '/')}（{wk[new Date(d.date + 'T00:00:00').getDay()]}）· {t} 點{d.waived ? `（免費 ${d.waived}）` : ''}</div>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div className="axis2 muted small">
                {range === 7
                  ? days.map((d, i) => <span key={d.date}>{i === days.length - 1 ? '今天' : wk[new Date(d.date + 'T00:00:00').getDay()]}</span>)
                  : [0, 7, 14, 21, 29].map(i => <span key={i} style={{ left: `${(i / 29) * 100}%` }} className="abs">{i === 29 ? '今天' : days[i]?.date.slice(5).replace('-', '/')}</span>)}
              </div>
            </section>

            <section className="kpis">
              <div className="kpi"><span className="muted small">累計儲值</span><b>{sum.purchased}</b><span className="muted small">點</span></div>
              <div className="kpi"><span className="muted small">累計使用</span><b>{sum.used}</b><span className="muted small">點</span></div>
              <div className="kpi"><span className="muted small">免費額度省下</span><b>{sum.waived}</b><span className="muted small">點 ≈ {twd(sum.waived * p.point_twd)}</span></div>
            </section>

            <section className="howto muted small">
              每個動作按價目扣點：第一版完整影片（含封面）約 {FIRST} 點，修改一輪約 {REV} 點，一支含 2 輪修改約 {FIRST + 2 * REV} 點；註冊送的 {p.signup_points} 點剛好夠做第一支。
              <a onClick={() => setTab('plans')}> 看方案</a>
            </section>
          </>
        )}

        {tab === 'projects' && (() => {
          const active = sum.projects.filter(x => x.used || x.waived || x.exports)
          const idle = sum.projects.filter(x => !(x.used || x.waived || x.exports))
          const topups = ledger.filter(l => !l.project_id)
          const tot = active.reduce((t, x) => t + x.used, 0)
          return (
            <div className="proj-list">
              <div className="pm-sum">
                <span><b>{active.length}</b> 個專案</span><span>完成 <b>{doneVideos}</b> 支 · 修改 <b>{revRounds}</b> 輪</span>
                <span>用掉 <b>{tot.toLocaleString()}</b> 點</span><span>餘額 <b>{sum.balance.toLocaleString()}</b> 點</span>
              </div>
              {active.length === 0 && <div className="muted">還沒有扣點的專案。</div>}
              {active.map(pr => {
                const total = pr.used + pr.waived
                const isOpen = open === pr.id
                const rows = ledger.filter(l => l.project_id === pr.id)
                return (
                  <section key={pr.id} className={`card proj ${isOpen ? 'open' : ''}`}>
                    <div className="proj-click" onClick={() => setOpen(isOpen ? null : pr.id)}>
                      <div className="proj-head">
                        <div className="proj-title">
                          <b>{pr.name}</b>{pr.free && <span className="pill">背包客 · 免費</span>}
                          <div className="muted small">{pr.exports > 0 ? '✓ 已完成' : '進行中'} · 修改 {pr.revision_turns} 輪 · {pr.updated_at.slice(5, 10).replace('-', '/')}</div>
                        </div>
                        <div className="proj-total">
                          <div className="num">{pr.used}<span className="unit">點</span></div>
                          {pr.waived > 0 && <div className="muted small">＋免費 {pr.waived}</div>}
                        </div>
                      </div>
                      {total > 0 && (
                        <>
                          <div className="stack">
                            {sum.categories.map(c => (pr.by_category[c.id] ?? 0) > 0 && (
                              <div key={c.id} className="seg" style={{ flex: pr.by_category[c.id], background: CAT_COLOR[c.id] }} title={`${c.label} ${pr.by_category[c.id]} 點`} />))}
                          </div>
                          <div className="legend wrap">
                            {sum.categories.map(c => (pr.by_category[c.id] ?? 0) > 0 && (
                              <span key={c.id}><i style={{ background: CAT_COLOR[c.id] }} />{c.label} <b>{pr.by_category[c.id]}</b></span>))}
                          </div>
                        </>
                      )}
                    </div>
                    {isOpen && (
                      <div className="pm-detail">
                        {total > 0 && <div className="tool-rows">
                          {Object.entries(pr.by_tool).sort((a, b) => b[1] - a[1]).map(([t, v]) => (
                            <div key={t} className="tool-row"><i style={{ background: CAT_COLOR[cat(t)] }} /><span>{label(t)}</span><b>{v} 點</b></div>))}
                        </div>}
                        {rows.length > 0 && <><div className="pm-sub muted small">每一筆紀錄</div>{dayGroups(rows, false)}</>}
                      </div>
                    )}
                    <div className="more muted small" onClick={() => setOpen(isOpen ? null : pr.id)}>{isOpen ? '收合' : '展開看每個步驟與每一筆'}</div>
                  </section>
                )
              })}
              {idle.length > 0 && <div className="pm-idle muted small">還沒扣點：{idle.map(x => x.name).join('、')}</div>}
              <section className="card ledger-card">
                <div className="ledger-head"><b>儲值與入帳</b><span className="muted small">累計 {sum.purchased.toLocaleString()} 點</span></div>
                {topups.length === 0 ? <div className="muted small" style={{ padding: '12px 0' }}>還沒有紀錄</div> : dayGroups(topups, false)}
              </section>
            </div>
          )
        })()}

        {tab === 'plans' && (
          <>
            {needPoints > 0 && (
              <section className="card need-banner">
                <div><b>剛剛那一步差 {needPoints} 點</b><div className="muted small">目前餘額 {sum.balance} 點。選個方案，入帳後回到專案輸入「繼續」就好。</div></div>
              </section>
            )}
            {/* 主方案是包月；單次購買放第一張，點進去才是零碎的點數包 */}
            <section className="pl-head"><h3>選一個方案</h3><span className="muted small">一支影片（含封面、2 輪修改）＝ 100 點</span></section>
            <div className="pl-free">✓ 包月隨時可取消，不綁約</div>
            <section className="pl-grid four">
              {myPlan ? (
                <div className="pl card payg member">
                  <div className="pl-ribbon mem">你的{myPlan.label}價</div>
                  <div className="pl-top"><b className="pl-name">加購點數</b></div>
                  <div className="pl-who">訂閱期間隨時加</div>
                  <div className="pl-label">1 點</div>
                  <div className="pl-price">{twd(myPlan.point_twd)}<s>{twd(p.point_twd)}</s></div>
                  <div className="pl-pt"><b>省 {myPlan.member_discount_pct}%</b><span>比單次購買</span></div>
                  <ul className="pl-list"><li>買多少都是這個價</li><li>點數累積不歸零</li></ul>
                  <button className="btn block primary" onClick={() => setTab('buy')}>加購點數</button>
                </div>
              ) : (
                <div className="pl card payg">
                  <div className="pl-top"><b className="pl-name">單次購買</b></div>
                  <div className="pl-who">偶爾剪一支</div>
                  <div className="pl-label">平均一支</div>
                  <div className="pl-price">{twd(single)}</div>
                  <div className="pl-pt"><b>1 點 {twd(p.point_twd)}</b></div>
                  <ul className="pl-list"><li>用多少買多少</li><li>點數不過期</li></ul>
                  <button className="btn block" onClick={() => setTab('buy')}>單次儲值</button>
                </div>
              )}
              {p.subscriptions.map(s => {
                const isCur = sub?.id === s.id
                const best = s.id === 'sub5'
                const off = Math.round((1 - s.point_twd / p.point_twd) * 100)
                return (
                  <div key={s.id} className={`pl card sub ${best ? 'best' : ''} ${isCur ? 'cur' : ''}`}>
                    {best && !isCur && <div className="pl-ribbon">最多人選</div>}
                    {isCur && <div className="pl-ribbon cur">目前方案</div>}
                    <div className="pl-top"><b className="pl-name">{s.label}</b><span className="pl-tag">包月</span></div>
                    <div className="pl-who">{twd(s.twd)} / 月 · {s.videos} 支</div>
                    <div className="pl-label">平均一支</div>
                    <div className="pl-price">{twd(s.per_video_twd)}</div>
                    <div className="pl-pt"><b>1 點 {twd(s.point_twd)}</b><span>省 {off}%</span></div>
                    <ul className="pl-list">
                      <li>之後儲值都用這個點數價</li>
                      <li>點數用不完會累積</li>
                      <li>{s.storage_gb} GB 成品空間</li>
                    </ul>
                    {isCur ? <button className="btn block" disabled>使用中</button>
                      : canBuy(s.checkout_url) ? <button className={`btn block ${best ? 'primary' : ''}`} onClick={() => buy(s.id)}>訂閱{s.label}</button>
                        : <button className="btn block" disabled>洽客服開通</button>}
                  </div>)
              })}
            </section>

            {/* 第二層：目前方案一行、成品空間 */}
            <section className={`pl-now ${me?.tier === 'free' ? 'free' : ''}`}>
              {me?.tier === 'free' ? <>
                <span className="pl-now-tag">目前：免費方案</span>
                <span>註冊送 {p.signup_points} 點 · 成品空間 {fmtGB(p.free_storage_gb)} · 保留 {p.free_retention_days} 天</span>
                <a onClick={() => document.getElementById('storage-sec')?.scrollIntoView({ behavior: 'smooth' })}>加購空間，成品一直保存 →</a>
              </> : <>
                <span className="pl-now-tag">目前：{sub ? sub.label : p.tiers.payg.label}</span>
                <span>新用戶註冊送 {p.signup_points} 點，第一支免費</span>
              </>}
            </section>
            <section id="storage-sec" className="card">
              <StorageInline subscribed={!!sub} onChanged={reload} onOpenProject={onOpenProject} />
            </section>

            {/* 第三層：細節收起來 */}
            <details className="pl-more card">
              <summary>看計算方式與細節</summary>
              <div className="pl-more-body">
                <div className="muted small">1 點 = {twd(p.point_twd)}。第一版（含封面）{FIRST} 點，修改一輪 {REV} 點。</div>
                <table className="price cmp">
                  <thead><tr><th>一個月 {sub5.videos} 支、每支改 2 輪</th><th className="r">單次購買</th><th className="r">{sub5.label}</th></tr></thead>
                  <tbody>
                    <tr><td>{sub5.videos} 支第一版 ＋ {sub5.revisions} 輪修改（{sub5.points} 點）</td><td className="r">{twd(sub5.videos * p.first_video_twd + sub5.revisions * p.revision_twd)}</td><td className="r muted">含</td></tr>
                    <tr><td>{sub5.storage_gb} GB 成品空間</td><td className="r">{twd(sub5.payg_twd - sub5.videos * p.first_video_twd - sub5.revisions * p.revision_twd)}</td><td className="r muted">含</td></tr>
                    <tr className="total"><td>每月合計</td><td className="r">{twd(sub5.payg_twd)}</td><td className="r"><b>{twd(sub5.twd)}</b></td></tr>
                  </tbody>
                </table>
                <ul className="muted small pl-rules">
                  <li>包月隨時可取消、不綁約，取消後已有的點數照樣保留。</li>
                  <li>訂閱立即生效，每 30 天續約；沒用完的點數（訂閱附的、自己買的）都會一直累積，不會重置。</li>
                  <li>自由輸入儲值點數，最少 20 點，300 點起加送。訂閱期間加買點數，一律用該方案的每點價格：{p.subscriptions.map(x => `${x.label} 1 點 ${twd(x.point_twd)}`).join('、')}（付一樣的錢，用多給點數的方式計算）。</li>
                  <li>免費空間的成品保留 {p.free_retention_days} 天後自動移除；加購空間（從點數扣，每 30 天續扣）就一直保存。點數不夠續扣時降回免費空間，從那天起再保留 {p.free_retention_days} 天。</li>
                </ul>
              </div>
            </details>
          </>
        )}

        {tab === 'buy' && (
          <>
            <div className="buy-back"><a onClick={() => setTab('plans')}>← 回到方案</a><b>{myPlan ? '加購點數' : '單次儲值點數'}</b>{!myPlan && <span className="muted small">常剪片的話，包月更划算</span>}</div>
            {myPlan && (
              <div className="mem-bar">
                <span className="mem-tag">{myPlan.label}價</span>
                <span>1 點 <b>{twd(myPlan.point_twd)}</b> <s>{twd(p.point_twd)}</s></span>
                <span className="mem-off">省 {myPlan.member_discount_pct}%</span>
                <span className="muted small">訂閱期間買多少都是這個價</span>
              </div>
            )}
            {needPoints > 0 && (
              <section className="card need-banner">
                <div><b>剛剛那一步差 {needPoints} 點</b><div className="muted small">目前餘額 {sum.balance} 點。儲值入帳後回到專案輸入「繼續」，剪輯師會接著做。</div></div>
                <span className="pill">建議 {sugg.n.toLocaleString()} 點</span>
              </section>
            )}
            {/* 自訂儲值：輸入點數，最少 MIN 點 */}
            <section className="card tu">
              <div className="tu-head"><b>要{myPlan ? '加購' : '儲值'}幾點？</b><span className="muted small">最少 {MIN} 點，輸入多少都可以</span></div>
              <div className="tu-row">
                <label className={`tu-input ${amt && !amtOk ? 'bad' : ''}`}>
                  <input inputMode="numeric" pattern="[0-9]*" value={amt} aria-label="儲值點數" onChange={e => setAmt(e.target.value.replace(/\D/g, '').slice(0, 5))} />
                  <span>點</span>
                </label>
                <div className="tu-chips">{[20, 100, 300, 500, 1000].map(n => <a key={n} className={`chipbtn ${amtN === n ? 'on' : ''}`} onClick={() => setAmt(String(n))}>{n}</a>)}</div>
              </div>
              {amt && !amtOk && <div className="error small">{amtN < MIN ? `最少 ${MIN} 點` : `一次最多 ${MAX.toLocaleString()} 點`}</div>}
              <div className="tu-out">
                <div><span>1 點</span><b>{twd(cur.rate)}{myPlan && <s>{twd(p.point_twd)}</s>}</b>{myPlan && <small className="mem">{myPlan.label}價 · 省 {myPlan.member_discount_pct}%</small>}</div>
                <div><span>實得</span><b>{cur.total.toLocaleString()} 點</b>{cur.bonus > 0 && <small className="ok">含送 {cur.bonus}</small>}</div>
                <div><span>約可剪</span><b>{(cur.total / (FIRST + 2 * REV)).toFixed(1)} 支</b></div>
              </div>
              <button className="btn primary block lg" disabled={!amtOk} onClick={() => buy(`pts:${amtN}`)}>
                {myPlan ? <>加購 {twd(cur.twd)}<s>{twd(Math.floor(cur.n * p.point_twd + 0.5))}</s></> : <>購買 {twd(cur.twd)}</>}
              </button>
              {myPlan && amtOk && <div className="tu-save">比單次購買省 {twd(Math.floor(cur.n * p.point_twd + 0.5) - cur.twd)}</div>}
              <div className="muted small tu-fine">
                {(p.topup_bonus ?? []).length > 0 && <>{p.topup_bonus[0].from} 點起加送 {p.topup_bonus[0].pct}%，最高送 {p.topup_bonus[p.topup_bonus.length - 1].pct}%。</>}
                {myPlan ? '' : `包月的話 1 點最低 ${twd(Math.min(...p.subscriptions.map(x => x.point_twd)))}。`}點數不過期。
              </div>
            </section>
            <section className="card calc">
              <div className="calc-head"><b>我想剪幾支？</b><span className="muted small">算給你看要買多少點</span></div>
              <div className="calc-row">
                <div className="stepper"><button className="btn small" onClick={() => setNVideos(v => Math.max(1, v - 1))}>−</button><b>{nVideos}</b><span className="muted small">支影片</span><button className="btn small" onClick={() => setNVideos(v => Math.min(60, v + 1))}>＋</button></div>
                <div className="calc-rev"><span className="muted small">每支修改</span>{[0, 1, 2, 3].map(n => <a key={n} className={`chipbtn ${nRev === n ? 'on' : ''}`} onClick={() => setNRev(n)}>{n} 輪</a>)}</div>
              </div>
              <div className="calc-out">
                <div><span className="muted small">需要</span><div className="num">{need.toLocaleString()}<span className="unit">點</span></div></div>
                <div><span className="muted small">建議儲值</span><div className="num small">{sugg.n.toLocaleString()} 點<span className="unit">{twd(sugg.twd)}</span></div></div>
                <button className="btn small" onClick={() => { setAmt(String(sugg.n)); window.scrollTo({ top: 0, behavior: 'smooth' }) }}>用這個數字</button>
              </div>
              <div className="cmp2">
                <div className="cmp2-head"><b>一個月剪 {nVideos} 支，哪個划算？</b><span className="muted small">需要 {need.toLocaleString()} 點</span></div>
                {compare.map(o => {
                  const save = compare[0].cost - o.cost
                  return (
                    <div key={o.id || 'payg'} className={`cmp2-row ${o === cheapest ? 'best' : ''}`}>
                      <div className="cmp2-name"><b>{o.label}</b>{o === cheapest && <span className="cmp2-tag">最划算</span>}
                        <small>{o.id ? `月費 ${twd(o.fee)} 含 ${o.incl.toLocaleString()} 點${o.buy ? `，再用${o.label}價加買 ${o.buy.n.toLocaleString()} 點` : ''}` : `儲值 ${o.buy?.n.toLocaleString() ?? 0} 點`}</small></div>
                      <div className="cmp2-num"><b>{twd(o.cost)}</b><small>{o.pts.toLocaleString()} 點 · 每點 {twd(o.rate)}</small></div>
                      <div className={`cmp2-save ${save > 0 ? 'pos' : ''}`}>{o.id ? (save > 0 ? `省 ${twd(save)}` : save < 0 ? `多 ${twd(-save)}` : '一樣') : '—'}</div>
                    </div>)
                })}
                <div className="muted small">訂閱另含成品空間（{p.subscriptions.map(x => `${x.label} ${x.storage_gb} GB`).join('、')}）。用不完的點數會累積到下個月。</div>
              </div>
            </section>
            {!p.provider_configured && <section className="howto muted small">{p.note}</section>}
            <section className="card">
              <b>價目</b>
              <div className="tool-rows">
                {p.menu.map(m => <div key={m.item} className="tool-row"><span>{m.item}</span><b>{m.points} 點</b></div>)}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>1 點 = {twd(p.point_twd)}。每個步驟做了才扣，沒做不扣。</div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
