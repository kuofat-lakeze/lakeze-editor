import { useEffect, useMemo, useState } from 'react'
import { api, type CreditsSummary, type Ledger, type Pricing } from './api'

// Fixed categorical order, validated for colour-vision separation on the light surface.
const CAT_COLOR: Record<string, string> = { cut: '#E8571C', audio: '#1B7AC3', subs: '#2E9E8F', export: '#7B61C4', cover: '#B8860B' }
export type CreditsTab = 'overview' | 'projects' | 'ledger' | 'buy'
const TABS: { id: CreditsTab; label: string }[] = [
  { id: 'overview', label: '總覽' }, { id: 'projects', label: '依專案' }, { id: 'ledger', label: '明細' }, { id: 'buy', label: '儲值' }]
const FIRST_VIDEO_POINTS = 39

const dayLabel = (iso: string) => {
  const d = new Date(iso); const t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  return same(d, t) ? '今天' : same(d, y) ? '昨天' : `${d.getMonth() + 1}/${d.getDate()}`
}

export function Credits({ initialTab = 'overview', onClose }: { initialTab?: CreditsTab; onClose: () => void }) {
  const [tab, setTab] = useState<CreditsTab>(initialTab)
  const [sum, setSum] = useState<CreditsSummary | null>(null)
  const [p, setP] = useState<Pricing | null>(null)
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    api.creditsSummary().then(setSum); api.pricing().then(setP); api.credits().then(r => setLedger(r.ledger))
  }, [])
  const buy = async (id: string) => { const { url } = await api.checkout(id); window.open(url, '_blank') }
  const label = (tool: string) => sum?.tool_labels[tool] ?? tool
  const cat = (tool: string) => {
    const m: Record<string, string> = { probe_footage: 'cut', sample_frames: 'cut', build_cut: 'cut', list_drive_folder: 'cut', download_footage: 'cut',
      search_voices: 'audio', generate_voice: 'audio', generate_music: 'audio', generate_sfx: 'audio', compose_audio: 'subs', render_captions: 'subs',
      preview_video: 'subs', export_video: 'export', make_cover: 'cover' }
    return m[tool] ?? 'subs'
  }
  const projName = useMemo(() => Object.fromEntries((sum?.projects ?? []).map(x => [x.id, x.name])), [sum])

  if (!sum || !p) return <div className="center muted">載入中…</div>
  const revisionsLeft = Math.floor(sum.balance / sum.revision_points)
  const videosLeft = sum.balance / FIRST_VIDEO_POINTS
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
  const best = p.packs.reduce((a, b) => (b.twd / b.points < a.twd / a.points ? b : a), p.packs[0])

  return (
    <div className="credits">
      <header>
        <h2>點數</h2>
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
                  {low ? '快用完了。' : ''}餘額約可付費修改 <b>{revisionsLeft}</b> 輪，或做 <b>{videosLeft.toFixed(1)}</b> 支新影片（每支約 NT${(FIRST_VIDEO_POINTS * p.point_twd).toLocaleString()}）
                </div>
              </div>
              <div className="hero-side">
                <button className="btn primary" onClick={() => setTab('buy')}>儲值</button>
                <a className="small" onClick={() => setTab('ledger')}>看明細</a>
              </div>
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
              <div className="kpi"><span className="muted small">免費額度省下</span><b>{sum.waived}</b><span className="muted small">點 ≈ NT${(sum.waived * p.point_twd).toLocaleString()}</span></div>
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
              每個動作按價目扣點：第一版完整影片（含封面）約 {FIRST_VIDEO_POINTS} 點，修改一輪約 {sum.revision_points} 點；第一個專案的第一版、封面與 4 輪修改免費。
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
                <option value="topup">儲值 / 加點</option>
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
                  const title = isCharge ? label(l.reason) : l.kind === 'purchase' ? '儲值' : l.kind === 'grant' ? '加點' : l.kind === 'refund' ? '退點' : l.reason
                  return (
                    <div key={i} className="lrow">
                      <i style={{ background: isCharge ? CAT_COLOR[cat(l.reason)] : 'var(--ok)' }} />
                      <div className="lmain">
                        <div>{title}</div>
                        <div className="muted small">{l.project_id ? projName[l.project_id] ?? '' : (l.reason !== title ? l.reason : '')}
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
            <section className="card price-guide">
              <b>一支影片大約多少錢</b>
              <div className="guide-grid">
                <div><span className="muted small">第一版完整影片（含封面）</span><div className="num">NT${(FIRST_VIDEO_POINTS * p.point_twd).toLocaleString()}<span className="unit">≈ {FIRST_VIDEO_POINTS} 點</span></div></div>
                <div><span className="muted small">修改一輪（重新混音、字幕、輸出）</span><div className="num">NT${(sum.revision_points * p.point_twd).toLocaleString()}<span className="unit">≈ {sum.revision_points} 點</span></div></div>
                <div><span className="muted small">多做一張封面</span><div className="num">NT${(4 * p.point_twd).toLocaleString()}<span className="unit">4 點</span></div></div>
              </div>
              <div className="muted small">第一個專案的第一版、封面與 4 輪修改免費。實際點數依每個步驟計算，見下方價目。</div>
            </section>
            <section className="packs-grid">
              {p.packs.map(k => (
                <div key={k.id} className={`packc card ${k.id === best.id ? 'best' : ''}`}>
                  {k.id === best.id && <div className="ribbon">最划算</div>}
                  <div className="packc-pts">{k.points}<span className="unit">點</span></div>
                  <div className="packc-price">NT${k.twd.toLocaleString()}</div>
                  <div className="muted small">每點 NT${(k.twd / k.points).toFixed(1)} · 約可做 <b>{(k.points / FIRST_VIDEO_POINTS).toFixed(1)} 支</b>新影片（每支約 NT${Math.round(FIRST_VIDEO_POINTS * k.twd / k.points).toLocaleString()}），或 {Math.floor(k.points / sum.revision_points)} 輪修改</div>
                  {k.checkout_url
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
              <div className="muted small" style={{ marginTop: 8 }}>1 點 = NT${p.point_twd}，點數不過期。</div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}
