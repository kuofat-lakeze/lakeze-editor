import { useEffect, useMemo, useState } from 'react'
import { PayFlow } from './Pay'
import { api, type CreditsSummary, type Ledger, type Me, type Pricing, type Subscription } from './api'
import { StorageInline } from './Storage'

// Fixed categorical order, validated for colour-vision separation on the light surface.
const CAT_COLOR: Record<string, string> = { cut: '#E8571C', audio: '#1B7AC3', subs: '#2E9E8F', export: '#7B61C4', cover: '#B8860B', storage: '#5B6B7A' }
export type CreditsTab = 'overview' | 'projects' | 'ledger' | 'plans' | 'buy' | 'storage'
const TABS: { id: CreditsTab; label: string }[] = [
  { id: 'plans', label: '方案' }, { id: 'buy', label: '儲值' }, { id: 'overview', label: '總覽' }, { id: 'projects', label: '依專案' }, { id: 'ledger', label: '明細' }]
const twd = (n: number) => `NT$${n.toLocaleString()}`
export const fmtGB = (gb: number) => gb < 1 ? `${Math.round(gb * 1000)} MB` : `${gb} GB`

const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  return same(d, t) ? '今天' : same(d, y) ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`
}

export function Credits({ initialTab = 'plans', needPoints = 0, onClose, onOpenProject, onBought }:
  { initialTab?: CreditsTab; needPoints?: number; onClose: () => void; onOpenProject?: (id: string) => void; onBought?: () => void }) {
  const [tab, setTab] = useState<CreditsTab>(initialTab === 'storage' ? 'plans' : initialTab)
  const [sum, setSum] = useState<CreditsSummary | null>(null)
  const [p, setP] = useState<Pricing | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [nVideos, setNVideos] = useState(5)
  const [nRev, setNRev] = useState(1)
  const reload = () => { api.creditsSummary().then(setSum); api.credits().then(r => setLedger(r.ledger)); api.me().then(setMe) }
  useEffect(() => { reload(); api.pricing().then(setP) }, [])
  useEffect(() => {
    if (initialTab === 'storage' && p) setTimeout(() => document.getElementById('storage-sec')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
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
  const maxDay = Math.max(1, ...sum.daily.map(d => d.used + d.waived))
  const month = sum.daily.reduce((a, d) => a + d.used + d.waived, 0)
  const monthPaid = sum.daily.reduce((a, d) => a + d.used, 0)
  const rows = ledger.filter(l => filter === 'all' || (filter === 'free' ? l.waived > 0 : filter === 'topup' ? l.delta > 0 : l.project_id === filter))
  const groups: { day: string; items: Ledger[] }[] = []
  for (const l of rows) {
    const day = dayLabel(l.created_at)
    const g = groups[groups.length - 1]
    if (g && g.day === day) g.items.push(l); else groups.push({ day, items: [l] })
  }
  const sub = me?.subscription ?? null
  const sub5 = p.subscriptions.find(s => s.id === 'sub5') ?? p.subscriptions[0]
  const inFree = !!sum.free_project?.in_free
  const single = p.first_video_twd + 2 * p.revision_twd   // one video with cover and 2 revision rounds, in NT$
  const singlePts = FIRST + 2 * REV                        // the same in points
  // top-up calculator
  const need = nVideos * FIRST + nVideos * nRev * REV
  const bestPack = p.packs.find(k => k.points >= (needPoints > 0 ? needPoints : need)) ?? p.packs[p.packs.length - 1]
  const packsNeeded = Math.ceil(need / bestPack.points)
  const member = !!sub                                   // subscribers top up at their plan's price per point
  const myPlan = sub ? p.subscriptions.find(x => x.id === sub.id) : undefined
  const rate = myPlan ? myPlan.point_twd : p.point_twd
  const packPrice = (k: typeof p.packs[number]) => (sub && k.member_twd[sub.id] ? k.member_twd[sub.id] : k.twd)

  return (
    <div className="credits">
      {toast && <div className="buy-toast">{toast}</div>}
      {paying && p && (() => {
        const pk = p.packs.find(x => x.id === paying); const sb = p.subscriptions.find(x => x.id === paying)
        const memberTwd = pk && me?.subscription ? pk.member_twd[me.subscription.id] : undefined
        const item = pk ? { id: pk.id, kind: 'pack' as const, title: `${pk.points} 點`, sub: `約可剪 ${Math.max(0, Math.floor(pk.points / (p.first_video_points + 2 * p.revision_points)))} 支（含封面與 2 輪修改）`, points: pk.points, twd: memberTwd ?? pk.twd, listTwd: memberTwd ? pk.twd : undefined }
          : sb ? { id: sb.id, kind: 'sub' as const, title: `${sb.label} · 月繳`, sub: `每月 ${sb.points} 點，約 ${sb.videos} 支 · ${sb.storage_gb} GB 空間`, points: sb.points, twd: sb.twd, listTwd: sb.payg_twd } : null
        return item && <PayFlow item={item} onClose={() => { setPaying(null); reload(); onBought?.() }} onPaid={() => { setPaying(null); setToast(`完成！${item.title}已入帳`); setTimeout(() => setToast(''), 5000); reload(); onBought?.() }} />
      })()}
      <header>
        <h2>點數與方案</h2>
        <div className="seg">
          {TABS.map(t => <a key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>{t.label}</a>)}
        </div>
        <a className="small back" onClick={onClose}>回到專案</a>
      </header>

      <div className="credits-body">
        {tab === 'overview' && (
          <>
            <section className={`hero card ${low ? 'low' : ''}`}>
              <div className="hero-main">
                <div className="eyebrow">目前餘額</div>
                <div className="hero-num">{sum.balance}<span className="unit">點</span></div>
                <div className="hero-sub">
                  {low ? '快用完了。' : ''}餘額約可付費修改 <b>{revisionsLeft}</b> 輪，或做 <b>{videosLeft.toFixed(1)}</b> 支新影片（每支約 {twd(p.first_video_twd)}）
                </div>
              </div>
              <div className="hero-side">
                <button className="btn primary" onClick={() => setTab('buy')}>儲值</button>
                <a className="small" onClick={() => setTab('plans')}>看方案</a>
              </div>
              {sub && (
                <div className="hero-free sub">
                  訂閱中：<b>{sub.label}</b>，本期含 {sub.points} 點（約 {sub.videos} 支影片）與 {sub.storage_gb} GB 成品空間
                  {sub.renews_at && <>，{sub.renews_at.slice(5, 10).replace('-', '/')} 續約</>}。訂閱點數當期有效，儲值點數不過期。
                </div>
              )}
              {sum.free_project && sum.free_project.in_free && (
                <div className="hero-free">
                  背包客方案進行中：「{sum.free_project.name}」{sum.free_project.free_revisions_left === null ? '第一版與封面免費' : `還有 ${sum.free_project.free_revisions_left} 輪免費修改`}，不會動到上面的餘額。
                </div>
              )}
              <div className="hero-foot">
                <span>最近 30 天用了 <b>{month}</b> 點</span>
                <span className="dot-sep" />
                <span>其中扣點 <b>{monthPaid}</b>、免費額度 <b>{month - monthPaid}</b></span>
              </div>
            </section>

            <section className="kpis">
              <div className="kpi"><span className="muted small">累計儲值</span><b>{sum.purchased}</b><span className="muted small">點</span></div>
              <div className="kpi"><span className="muted small">累計使用</span><b>{sum.used}</b><span className="muted small">點</span></div>
              <div className="kpi"><span className="muted small">免費額度省下</span><b>{sum.waived}</b><span className="muted small">點 ≈ {twd(sum.waived * p.point_twd)}</span></div>
            </section>

            <section className="card chart">
              <div className="chart-head">
                <div><b>每日用量</b><div className="muted small">最近 30 天</div></div>
                <span className="legend"><i style={{ background: CAT_COLOR.cut }} />扣點<i className="hatch" />免費額度</span>
              </div>
              <div className="plot">
                <div className="grid"><span /><span /><span /></div>
                <div className="bars" role="img" aria-label="最近 30 天每日點數用量" onMouseLeave={() => setHover(null)}>
                  {sum.daily.map((d, i) => {
                    const t = d.used + d.waived
                    return (
                      <div key={d.date} className={`bar-col ${hover === i ? 'hover' : ''}`} onMouseEnter={() => setHover(i)}>
                        <div className="bar-stack" style={{ height: `${Math.max(t ? 3 : 0, (t / maxDay) * 100)}%` }}>
                          {d.waived > 0 && <div className="seg hatch" style={{ flex: d.waived }} />}
                          {d.used > 0 && <div className="seg" style={{ flex: d.used, background: CAT_COLOR.cut }} />}
                        </div>
                        {hover === i && <div className="tip">{d.date.slice(5).replace('-', '/')} · {t} 點{d.waived ? `（免費 ${d.waived}）` : ''}</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="axis muted small">
                {[0, 7, 14, 21, 29].map(i => <span key={i} style={{ left: `${(i / 29) * 100}%` }}>{i === 29 ? '今天' : sum.daily[i]?.date.slice(5).replace('-', '/')}</span>)}
              </div>
            </section>

            <section className="howto muted small">
              每個動作按價目扣點：第一版完整影片（含封面）約 {FIRST} 點，修改一輪約 {REV} 點，一支含 2 輪修改約 {FIRST + 2 * REV} 點；註冊送的 {p.signup_points} 點剛好夠做第一支。
              <a onClick={() => setTab('buy')}> 看價目</a>
            </section>
          </>
        )}

        {tab === 'projects' && (
          <div className="proj-list">
            {sum.projects.length === 0 && <div className="muted">還沒有專案。</div>}
            {sum.projects.map(pr => {
              const total = pr.used + pr.waived
              const isOpen = open === pr.id
              return (
                <section key={pr.id} className={`card proj ${isOpen ? 'open' : ''}`} onClick={() => setOpen(isOpen ? null : pr.id)}>
                  <div className="proj-head">
                    <div className="proj-title">
                      <b>{pr.name}</b>{pr.free && <span className="pill">背包客 · 免費</span>}
                      <div className="muted small">輸出 {pr.exports} 次 · 修改 {pr.revision_turns} 輪 · {pr.updated_at.slice(5, 10).replace('-', '/')}</div>
                    </div>
                    <div className="proj-total">
                      <div className="num">{pr.used}<span className="unit">點</span></div>
                      {pr.waived > 0 && <div className="muted small">＋免費 {pr.waived}</div>}
                    </div>
                  </div>
                  {total > 0 ? (
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
                  ) : <div className="muted small">還沒有扣點</div>}
                  {isOpen && total > 0 && (
                    <div className="tool-rows">
                      {Object.entries(pr.by_tool).sort((a, b) => b[1] - a[1]).map(([t, v]) => (
                        <div key={t} className="tool-row"><i style={{ background: CAT_COLOR[cat(t)] }} /><span>{label(t)}</span><b>{v} 點</b></div>))}
                    </div>
                  )}
                  <div className="more muted small">{isOpen ? '收合' : '展開看每個步驟'}</div>
                </section>
              )
            })}
          </div>
        )}

        {tab === 'ledger' && (
          <section className="card ledger-card">
            <div className="ledger-head">
              <select value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="all">全部紀錄</option>
                <option value="topup">儲值 / 加點 / 訂閱</option>
                <option value="free">免費額度</option>
                {sum.projects.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
              <span className="muted small">{rows.length} 筆</span>
            </div>
            {groups.length === 0 && <div className="muted small" style={{ padding: '12px 0' }}>還沒有紀錄</div>}
            {groups.map(g => (
              <div key={g.day} className="lgroup">
                <div className="lday muted small">{g.day}</div>
                {g.items.map((l, i) => {
                  const isCharge = l.kind === 'charge'
                  const title = isCharge ? label(l.reason) : l.kind === 'purchase' ? '儲值' : l.kind === 'grant' ? '加點' : l.kind === 'refund' ? '退點'
                    : l.kind === 'subscription' ? '訂閱點數入帳' : l.kind === 'expire' ? '訂閱點數到期' : l.reason
                  return (
                    <div key={i} className="lrow">
                      <i style={{ background: isCharge ? CAT_COLOR[cat(l.reason)] : l.kind === 'expire' ? '#C9C3B8' : 'var(--ok)' }} />
                      <div className="lmain">
                        <div>{title}</div>
                        <div className="muted small">{l.project_id ? projName[l.project_id] ?? '' : (l.reason !== title && l.kind !== 'expire' ? l.reason : '')}
                          {' '}{new Date(l.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false })}</div>
                      </div>
                      <div className={`lamt ${l.delta > 0 ? 'ok' : ''}`}>
                        {l.delta > 0 ? `+${l.delta}` : l.delta < 0 ? `−${-l.delta}` : <span className="muted">免 {l.waived}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </section>
        )}

        {tab === 'plans' && (
          <>
            {me?.tier === 'free' ? (
              <section className="card free-now">
                <div className="fn-head"><span className="fn-badge">目前方案</span><b>你現在是免費方案</b><span className="muted small">{p.tiers.free.label}</span></div>
                <ul className="fn-list">
                  <li><i>🎁</i><span>註冊送的 <b>{p.signup_points} 點</b>已入帳，夠做一支影片含封面與 2 輪修改</span></li>
                  <li><i>📦</i><span>成品空間 <b>{fmtGB(p.free_storage_gb)}</b></span></li>
                  <li><i>⏳</i><span>成品保留 <b>{p.free_retention_days} 天</b>，之後自動移除，記得先下載</span></li>
                </ul>
                <div className="fn-cta">
                  <button className="btn primary" onClick={() => document.getElementById('storage-sec')?.scrollIntoView({ behavior: 'smooth' })}>加購空間，成品一直保存</button>
                  <span className="muted small">不用訂閱，單純用點數買空間就行</span>
                </div>
              </section>
            ) : (
              <div className="free-line">
                <span className="free-dot">免費</span>
                <span><b>註冊就送 {p.signup_points} 點</b>，成品空間 {fmtGB(p.free_storage_gb)}、保留 {p.free_retention_days} 天。</span>
              </div>
            )}

            <section className="plans-head">
              <b>單次購買</b>
              <span className="muted small">以點數計價，用多少扣多少，不過期。1 點 = {twd(p.point_twd)}。</span>
            </section>
            <section className="plans-grid single">
              <div className={`plan card tier payg ${!sub && !inFree ? 'cur' : ''}`}>
                {!sub && !inFree && <div className="ribbon cur">目前</div>}
                <div className="plan-name">{p.tiers.payg.label}</div>
                <div className="plan-who">{p.tiers.payg.who}</div>
                <div className="plan-price">{singlePts}<small>點 / 支，含 2 輪修改</small></div>
                <div className="plan-sub">約 {twd(single)} 一支<span className="muted"> · 第一版 {FIRST} 點，修改一輪 {REV} 點</span></div>
                <ul className="plan-list">
                  <li>免費版的全部功能，自己的聲音不限秒數</li>
                  <li>成品空間 {fmtGB(p.free_storage_gb)}（保留 {p.free_retention_days} 天），加購空間就一直保存</li>
                </ul>
                <button className="btn block" onClick={() => setTab('buy')}>儲值點數</button>
              </div>
            </section>

            <section className="plans-head">
              <b>包月更便宜</b>
              <span className="muted small">同樣的點數，包月 1 點只要約 {twd(p.member_point_twd)} 起。一支含 2 輪修改：單次約 {twd(single)}，包月約 <b>{twd(sub5.per_video_twd)}</b> 起。</span>
            </section>
            <section className="plans-grid subs">
              {p.subscriptions.map((s, i) => (
                <PlanCard key={s.id} s={s} prev={i === 0 ? p.tiers.payg.label : p.subscriptions[i - 1].label} single={single} singlePts={singlePts} pointTwd={p.point_twd} current={sub?.id === s.id} onBuy={buy} canBuy={canBuy(s.checkout_url)} />))}
            </section>

            <section className="card compare">
              <b>一個月 {sub5.videos} 支、每支改 2 輪</b>
              <table className="price cmp">
                <thead><tr><th></th><th className="r">點數</th><th className="r">單次購買</th><th className="r">{sub5.label}</th></tr></thead>
                <tbody>
                  <tr><td>{sub5.videos} 支第一版（含封面）</td><td className="r">{sub5.videos * FIRST} 點</td><td className="r">{twd(sub5.videos * p.first_video_twd)}</td><td className="r muted">含</td></tr>
                  <tr><td>{sub5.revisions} 輪修改</td><td className="r">{sub5.revisions * REV} 點</td><td className="r">{twd(sub5.revisions * p.revision_twd)}</td><td className="r muted">含</td></tr>
                  <tr><td>{sub5.storage_gb} GB 成品空間</td><td className="r">{(p.storage_plans.find(x => x.id === sub5.storage_plan)?.points ?? 0)} 點 / 月</td><td className="r">{twd(sub5.payg_twd - sub5.videos * p.first_video_twd - sub5.revisions * p.revision_twd)}</td><td className="r muted">含</td></tr>
                  <tr className="total"><td>每月</td><td className="r">{sub5.points} 點</td><td className="r">{twd(sub5.payg_twd)}</td><td className="r"><b>{twd(sub5.twd)}</b></td></tr>
                  <tr><td>平均一支（含 2 輪修改）</td><td className="r">{singlePts} 點</td><td className="r">{twd(Math.round(sub5.payg_twd / sub5.videos))}</td><td className="r"><b>{twd(sub5.per_video_twd)}</b></td></tr>
                </tbody>
              </table>
              <div className="save-line">包月每支省 <b>{twd(single - sub5.per_video_twd)}</b>，一年省 {twd((single - sub5.per_video_twd) * sub5.videos * 12)}。</div>
            </section>

            <section id="storage-sec" className="card">
              <StorageInline subscribed={!!sub} onChanged={reload} onOpenProject={onOpenProject} />
            </section>
            <section className="howto muted small">
              訂閱立即生效，每 30 天續約；訂閱附的點數當期有效，不夠再儲值（儲值點數不過期）。免費空間 {fmtGB(p.free_storage_gb)}，成品保留 {p.free_retention_days} 天後自動移除；加購空間（從點數扣，每 30 天續扣）就一直保存。點數不夠續扣時降回免費空間，從那天起再保留 {p.free_retention_days} 天。
            </section>
          </>
        )}

        {tab === 'buy' && (
          <>
            {needPoints > 0 && (
              <section className="card need-banner">
                <div><b>剛剛那一步差 {needPoints} 點</b><div className="muted small">目前餘額 {sum.balance} 點。儲值入帳後回到專案輸入「繼續」，剪輯師會接著做。</div></div>
                <span className="pill">建議 {(p.packs.find(k => k.points >= needPoints) ?? p.packs[p.packs.length - 1]).points} 點</span>
              </section>
            )}
            <section className="card calc">
              <div className="calc-head"><b>我想剪幾支？</b><span className="muted small">算給你看要買多少點</span></div>
              <div className="calc-row">
                <div className="stepper"><button className="btn small" onClick={() => setNVideos(v => Math.max(1, v - 1))}>−</button><b>{nVideos}</b><span className="muted small">支影片</span><button className="btn small" onClick={() => setNVideos(v => Math.min(60, v + 1))}>＋</button></div>
                <div className="calc-rev"><span className="muted small">每支修改</span>{[0, 1, 2, 3].map(n => <a key={n} className={`chipbtn ${nRev === n ? 'on' : ''}`} onClick={() => setNRev(n)}>{n} 輪</a>)}</div>
              </div>
              <div className="calc-out">
                <div><span className="muted small">需要</span><div className="num">{need}<span className="unit">點</span></div></div>
                <div><span className="muted small">約{member ? '（會員價）' : ''}</span><div className="num">{twd(Math.round(need * rate))}</div></div>
                <div><span className="muted small">建議</span><div className="num small">{packsNeeded > 1 ? `${packsNeeded} 份 ` : ''}{bestPack.points} 點包<span className="unit">{twd(packPrice(bestPack) * packsNeeded)}</span></div></div>
              </div>
              {member && myPlan && <div className="calc-tip member">你是 {myPlan.label} 會員，儲值一律會員價 NT${myPlan.point_twd} / 點（省 {myPlan.member_discount_pct}%），加買的影片跟方案內一樣划算。</div>}
              {nVideos >= sub5.videos && !sub && (
                <div className="calc-tip">一個月要剪 {nVideos} 支的話，<b>{sub5.label}</b>訂閱 {twd(sub5.twd)} 含 {sub5.videos} 支＋{sub5.revisions} 輪修改＋{sub5.storage_gb} GB，每支 {twd(sub5.per_video_twd)}。<a onClick={() => setTab('plans')}>看方案</a></div>
              )}
            </section>
            <section className="packs-grid">
              {p.packs.map(k => (
                <div key={k.id} className={`packc card ${k.id === bestPack.id ? 'best' : ''}`}>
                  {k.id === bestPack.id && <div className="ribbon">剛好夠</div>}
                  <div className="packc-pts">{k.points}<span className="unit">點</span></div>
                  <div className="packc-price">{twd(packPrice(k))}{member && <s className="muted small">{twd(k.twd)}</s>}{member && <span className="member-tag">會員價</span>}</div>
                  {k.points >= FIRST + 2 * REV
                    ? <div className="packc-videos">約可剪 <b>{Math.floor(k.points / (FIRST + 2 * REV))}</b> 支<span className="muted small">（含封面與 2 輪修改）</span></div>
                    : <div className="packc-videos">補點用<span className="muted small">：約 {Math.floor(k.points / REV)} 輪修改，或補足第一支</span></div>}
                  <div className="muted small">點數不過期{!member && <> · 包月會員 {twd(k.member_twd.sub5)} 起</>}</div>
                  {canBuy(sub ? (k.member_checkout_url?.[sub.id] || k.checkout_url) : k.checkout_url)
                    ? <button className="btn primary block" onClick={() => buy(k.id)}>購買</button>
                    : <button className="btn block" disabled>洽客服開通</button>}
                </div>
              ))}
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

function PlanCard({ s, prev, single, singlePts, pointTwd, current, onBuy, canBuy }:
  { s: Subscription; prev: string; single: number; singlePts: number; pointTwd: number; current: boolean; onBuy: (id: string) => void; canBuy: boolean }) {
  const best = s.id === 'sub5'
  return (
    <div className={`plan card sub ${best ? 'best' : ''} ${current ? 'cur' : ''}`}>
      {current ? <div className="ribbon cur">目前方案</div> : best ? <div className="ribbon">最划算</div> : <div className="ribbon alt">大量出片</div>}
      <div className="plan-name">{s.label}</div>
      <div className="plan-who">{s.who}</div>
      <div className="plan-price">{s.points.toLocaleString()}<small>點 / 月</small></div>
      <div className="plan-sub">{twd(s.twd)} / 月<span className="muted"> · 1 點約 {twd(s.point_twd)}（單次 {twd(pointTwd)}）</span></div>
      <ul className="plan-list">
        <li>約 <b>{s.videos} 支</b>，每支含 2 輪修改（{singlePts} 點）</li>
        <li>每支約 <b>{twd(s.per_video_twd)}</b><s className="muted">單次 {twd(single)}</s></li>
        <li><b>{s.storage_gb} GB</b> 成品空間，含 {prev} 全部功能</li>
      </ul>
      <div className="save-badge">每支省 {twd(single - s.per_video_twd)}，一年省 {twd((single - s.per_video_twd) * s.videos * 12)}</div>
      {current ? <button className="btn block" disabled>使用中</button>
        : canBuy ? <button className="btn primary block" onClick={() => onBuy(s.id)}>訂閱</button>
          : <button className="btn block" disabled>洽客服開通</button>}
    </div>
  )
}
