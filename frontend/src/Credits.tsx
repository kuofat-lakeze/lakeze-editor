import { useEffect, useMemo, useState } from 'react'
import { api, type CreditsSummary, type Ledger, type Me, type Pricing, type Subscription } from './api'
import { StoragePanel } from './Storage'

// Fixed categorical order, validated for colour-vision separation on the light surface.
const CAT_COLOR: Record<string, string> = { cut: '#E8571C', audio: '#1B7AC3', subs: '#2E9E8F', export: '#7B61C4', cover: '#B8860B', storage: '#5B6B7A' }
export type CreditsTab = 'overview' | 'projects' | 'ledger' | 'buy' | 'storage'
const TABS: { id: CreditsTab; label: string }[] = [
  { id: 'overview', label: '總覽' }, { id: 'projects', label: '依專案' }, { id: 'ledger', label: '明細' }, { id: 'buy', label: '方案' }, { id: 'storage', label: '空間' }]
const twd = (n: number) => `NT$${n.toLocaleString()}`

const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  return same(d, t) ? '今天' : same(d, y) ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`
}

export function Credits({ initialTab = 'overview', onClose, onOpenProject }: { initialTab?: CreditsTab; onClose: () => void; onOpenProject?: (id: string) => void }) {
  const [tab, setTab] = useState<CreditsTab>(initialTab)
  const [sum, setSum] = useState<CreditsSummary | null>(null)
  const [p, setP] = useState<Pricing | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const reload = () => { api.creditsSummary().then(setSum); api.credits().then(r => setLedger(r.ledger)); api.me().then(setMe) }
  useEffect(() => { reload(); api.pricing().then(setP) }, [])
  const buy = async (id: string) => { const { url } = await api.checkout(id); window.open(url, '_blank') }
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

  return (
    <div className="credits">
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
                <button className="btn primary" onClick={() => setTab('buy')}>{sub ? '儲值' : '看方案'}</button>
                <a className="small" onClick={() => setTab('ledger')}>看明細</a>
              </div>
              {sub && (
                <div className="hero-free sub">
                  訂閱中：<b>{sub.label}</b>，本期含 {sub.points} 點（約 {sub.videos} 支影片）與 {sub.storage_gb} GB 成品空間
                  {sub.renews_at && <>，{sub.renews_at.slice(5, 10).replace('-', '/')} 續約</>}。訂閱點數當期有效，儲值點數不過期。
                </div>
              )}
              {sum.free_project && sum.free_project.in_free && (
                <div className="hero-free">
                  免費專案「{sum.free_project.name}」：{sum.free_project.free_revisions_left === null ? '第一版與封面免費' : `還有 ${sum.free_project.free_revisions_left} 輪免費修改`}，不會動到上面的餘額。
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
              每個動作按價目扣點：第一版完整影片（含封面）約 {FIRST} 點，修改一輪約 {REV} 點；第一個專案的第一版、封面與 {p.free_revision_turns} 輪修改免費。
              <a onClick={() => setTab('buy')}> 看方案與價目</a>
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
                      <b>{pr.name}</b>{pr.free && <span className="pill">免費專案</span>}
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
                        <div className="muted small">{l.project_id ? projName[l.project_id] ?? '' : (l.reason !== title && !['expire'].includes(l.kind) ? l.reason : '')}
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

        {tab === 'buy' && (
          <>
            {sub && (
              <section className="card sub-now">
                <div><span className="eyebrow">目前訂閱</span><b className="sub-name">{sub.label}</b>
                  <div className="muted small">本期 {sub.points} 點 · {sub.storage_gb} GB 成品空間{sub.renews_at && ` · ${sub.renews_at.slice(5, 10).replace('-', '/')} 續約`} · 餘額 {sum.balance} 點</div></div>
                <a className="small" onClick={() => setTab('storage')}>看空間</a>
              </section>
            )}
            <section className="plans-head">
              <b>兩種付法，看你一個月剪幾支</b>
              <span className="muted small">偶爾剪就按次付；一個月 {sub5.videos} 支以上，訂閱每支便宜 {twd(p.first_video_twd + 2 * p.revision_twd - sub5.per_video_twd)}，還送成品空間。</span>
            </section>
            <section className="plans-grid">
              <div className={`plan card payg ${!sub ? 'cur' : ''}`}>
                {!sub && <div className="ribbon cur">目前</div>}
                <div className="plan-name">按次付費</div>
                <div className="plan-price">{twd(p.first_video_twd)}<small>/ 支</small></div>
                <div className="plan-sub muted small">第一版含封面 {FIRST} 點 · 修改一輪 {twd(p.revision_twd)}</div>
                <ul className="plan-list">
                  <li>先儲值，做什麼扣什麼</li>
                  <li>點數不過期</li>
                  <li>成品空間 2 GB 免費，要更多另外加購</li>
                  <li>第一個專案免費試做</li>
                </ul>
                <a className="btn block" href="#packs" onClick={e => { e.preventDefault(); document.getElementById('packs')?.scrollIntoView({ behavior: 'smooth' }) }}>儲值點數</a>
              </div>
              {p.subscriptions.map(s => <PlanCard key={s.id} s={s} p={p} current={sub?.id === s.id} onBuy={buy} />)}
            </section>

            <section className="card compare">
              <b>以一個月 {sub5.videos} 支影片算</b>
              <table className="price cmp">
                <thead><tr><th></th><th className="r">按次付費</th><th className="r">{sub5.label}</th></tr></thead>
                <tbody>
                  <tr><td>{sub5.videos} 支第一版（含封面）</td><td className="r">{twd(sub5.videos * p.first_video_twd)}</td><td className="r muted">含</td></tr>
                  <tr><td>{sub5.revisions} 輪修改（每支 2 輪）</td><td className="r">{twd(sub5.revisions * p.revision_twd)}</td><td className="r muted">含</td></tr>
                  <tr><td>{sub5.storage_gb} GB 成品空間</td><td className="r">{twd(sub5.payg_twd - sub5.videos * p.first_video_twd - sub5.revisions * p.revision_twd)}</td><td className="r muted">含</td></tr>
                  <tr className="total"><td>每月合計</td><td className="r">{twd(sub5.payg_twd)}</td><td className="r"><b>{twd(sub5.twd)}</b></td></tr>
                  <tr><td>平均每支（含 2 輪修改）</td><td className="r">{twd(Math.round(sub5.payg_twd / sub5.videos))}</td><td className="r"><b>{twd(sub5.per_video_twd)}</b></td></tr>
                </tbody>
              </table>
              <div className="save-line">訂閱每月省 <b>{twd(sub5.save_twd)}</b>（{sub5.save_pct}%），一年省 {twd(sub5.save_twd * 12)}。</div>
            </section>

            <section id="packs" className="card price-guide">
              <b>儲值點數</b>
              <div className="muted small">1 點 = {twd(p.point_twd)}，不過期。按次付費或訂閱點數用完時加購都用這裡。</div>
              <div className="packs-grid">
                {p.packs.map(k => (
                  <div key={k.id} className="packc card">
                    <div className="packc-pts">{k.points}<span className="unit">點</span></div>
                    <div className="packc-price">{twd(k.twd)}</div>
                    <div className="muted small">約 <b>{(k.points / FIRST).toFixed(1)} 支</b>新影片，或 {Math.floor(k.points / REV)} 輪修改</div>
                    {k.checkout_url
                      ? <button className="btn primary block" onClick={() => buy(k.id)}>購買</button>
                      : <button className="btn block" disabled>洽客服開通</button>}
                  </div>
                ))}
              </div>
              {!p.provider_configured && <div className="howto muted small">{p.note}</div>}
            </section>
            <section className="card">
              <b>價目</b>
              <div className="tool-rows">
                {p.menu.map(m => <div key={m.item} className="tool-row"><span>{m.item}</span><b>{m.points} 點</b></div>)}
              </div>
              <div className="muted small" style={{ marginTop: 8 }}>1 點 = {twd(p.point_twd)}。訂閱附的點數當期有效；儲值的點數不過期。</div>
            </section>
          </>
        )}

        {tab === 'storage' && <StoragePanel onChanged={reload} onOpenProject={onOpenProject} />}
      </div>
    </div>
  )
}

function PlanCard({ s, p, current, onBuy }: { s: Subscription; p: Pricing; current: boolean; onBuy: (id: string) => void }) {
  const best = s.id === 'sub5'
  return (
    <div className={`plan card sub ${best ? 'best' : ''} ${current ? 'cur' : ''}`}>
      {current ? <div className="ribbon cur">目前方案</div> : best ? <div className="ribbon">最划算</div> : <div className="ribbon alt">多間 · 代操</div>}
      <div className="plan-name">{s.label}</div>
      <div className="plan-price">{twd(s.twd)}<small>/ 月</small></div>
      <div className="plan-sub muted small">每支 {twd(s.per_video_twd)}，含 2 輪修改</div>
      <ul className="plan-list">
        <li>每月 <b>{s.videos} 支</b>影片（{s.points} 點）</li>
        <li>每支含 <b>2 輪</b>修改，共 {s.revisions} 輪</li>
        <li><b>{s.storage_gb} GB</b> 成品空間（按次要 {twd(s.payg_twd - s.videos * p.first_video_twd - s.revisions * p.revision_twd)}/月）</li>
        <li>點數當期有效，不夠再儲值</li>
      </ul>
      <div className="save-badge">比按次省 {twd(s.save_twd)}（{s.save_pct}%）/ 月</div>
      {current ? <button className="btn block" disabled>使用中</button>
        : s.checkout_url ? <button className="btn primary block" onClick={() => onBuy(s.id)}>訂閱</button>
          : <button className="btn block" disabled>洽客服開通</button>}
    </div>
  )
}
