import { useEffect, useMemo, useState } from 'react'
import { api, type CreditsSummary, type Ledger, type Pricing } from './api'

// Fixed categorical order, validated for colour-vision separation on the light surface.
const CAT_COLOR: Record<string, string> = { cut: '#E8571C', audio: '#1B7AC3', subs: '#2E9E8F', export: '#7B61C4', cover: '#B8860B' }
export type CreditsTab = 'overview' | 'projects' | 'ledger' | 'buy'

export function Credits({ initialTab = 'overview', onClose }: { initialTab?: CreditsTab; onClose: () => void }) {
  const [tab, setTab] = useState<CreditsTab>(initialTab)
  const [sum, setSum] = useState<CreditsSummary | null>(null)
  const [p, setP] = useState<Pricing | null>(null)
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    api.creditsSummary().then(setSum); api.pricing().then(setP); api.credits().then(r => setLedger(r.ledger))
  }, [])
  const buy = async (id: string) => { const { url } = await api.checkout(id); window.open(url, '_blank') }
  const label = (tool: string) => sum?.tool_labels[tool] ?? tool
  const projName = useMemo(() => Object.fromEntries((sum?.projects ?? []).map(x => [x.id, x.name])), [sum])

  if (!sum || !p) return <div className="center muted">載入中…</div>
  const revisionsLeft = Math.floor(sum.balance / sum.revision_points)
  const low = sum.balance < 10
  const maxDay = Math.max(1, ...sum.daily.map(d => d.used + d.waived))
  const month = sum.daily.reduce((a, d) => a + d.used + d.waived, 0)
  const rows = ledger.filter(l => filter === 'all' || (filter === 'free' ? l.waived > 0 : filter === 'topup' ? l.delta > 0 : l.project_id === filter))

  return (
    <div className="credits">
      <header>
        <h2>點數</h2>
        <span className="muted small">1 點 = NT${p.point_twd}，點數不過期</span>
        <a className="small" style={{ marginLeft: 'auto' }} onClick={onClose}>回到專案</a>
      </header>
      <div className="tabs pad">
        <a className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>總覽</a>
        <a className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>依專案</a>
        <a className={tab === 'ledger' ? 'active' : ''} onClick={() => setTab('ledger')}>明細</a>
        <a className={tab === 'buy' ? 'active' : ''} onClick={() => setTab('buy')}>儲值</a>
      </div>
      <div className="credits-body">
        {tab === 'overview' && (
          <>
            <div className="stats">
              <div className={`stat card ${low ? 'low' : ''}`}>
                <div className="muted small">目前餘額</div>
                <div className="big">{sum.balance} <span className="unit">點</span></div>
                <div className="muted small">{low ? '快用完了：' : ''}大約還能修改 {revisionsLeft} 輪（一輪約 {sum.revision_points} 點）</div>
                {low && <button className="btn primary small" onClick={() => setTab('buy')}>立即儲值</button>}
              </div>
              <Stat k="累計儲值" v={`${sum.purchased}`} s={`點${sum.refunded ? `，退 ${-sum.refunded}` : ''}`} />
              <Stat k="累計使用" v={`${sum.used}`} s="點（不含免費額度）" />
              <Stat k="免費額度幫你省下" v={`${sum.waived}`} s={`點 ≈ NT$${(sum.waived * p.point_twd).toLocaleString()}`} />
            </div>
            <div className="card chart">
              <div className="chart-head"><b>最近 30 天用量</b><span className="muted small">共 {month} 點</span>
                <span className="legend"><i style={{ background: CAT_COLOR.cut }} />扣點 <i className="hatch" />免費額度</span></div>
              <div className="bars" role="img" aria-label="最近 30 天每日點數用量">
                {sum.daily.map(d => {
                  const t = d.used + d.waived
                  return (
                    <div key={d.date} className="bar-col" title={`${d.date}：扣 ${d.used} 點，免費額度 ${d.waived} 點`}>
                      <div className="bar-stack" style={{ height: `${(t / maxDay) * 100}%` }}>
                        {d.waived > 0 && <div className="seg hatch" style={{ flex: d.waived }} />}
                        {d.used > 0 && <div className="seg" style={{ flex: d.used, background: CAT_COLOR.cut }} />}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="axis muted small"><span>{sum.daily[0]?.date.slice(5)}</span><span>今天</span></div>
            </div>
            <div className="card">
              <b>點數怎麼算</b>
              <p className="muted small" style={{ margin: '6px 0 0' }}>
                每個動作按價目扣點：第一版完整影片（含封面）約 39 點，修改一輪（重新混音、字幕、輸出）約 8 點。
                第一個專案的第一版、封面與 4 輪修改免費。到「依專案」可以看每支影片實際花了多少。
              </p>
            </div>
          </>
        )}

        {tab === 'projects' && (
          <div className="proj-list">
            {sum.projects.length === 0 && <div className="muted">還沒有專案。</div>}
            {sum.projects.map(pr => {
              const total = pr.used + pr.waived
              return (
                <div key={pr.id} className="card proj" onClick={() => setOpen(open === pr.id ? null : pr.id)}>
                  <div className="proj-head">
                    <div><b>{pr.name}</b>{pr.free && <span className="tag">免費專案</span>}
                      <div className="muted small">輸出 {pr.exports} 次 · 修改 {pr.revision_turns} 輪 · {pr.updated_at.slice(0, 10)}</div></div>
                    <div className="proj-total"><span className="big">{pr.used}</span> <span className="muted small">點{pr.waived ? ` + 免費 ${pr.waived}` : ''}</span></div>
                  </div>
                  {total > 0 && (
                    <div className="stack" title={sum.categories.map(c => `${c.label} ${pr.by_category[c.id] ?? 0}`).join('，')}>
                      {sum.categories.map(c => (pr.by_category[c.id] ?? 0) > 0 && (
                        <div key={c.id} className="seg" style={{ flex: pr.by_category[c.id], background: CAT_COLOR[c.id] }} />))}
                    </div>
                  )}
                  <div className="legend wrap">
                    {sum.categories.map(c => (pr.by_category[c.id] ?? 0) > 0 && (
                      <span key={c.id}><i style={{ background: CAT_COLOR[c.id] }} />{c.label} {pr.by_category[c.id]}</span>))}
                  </div>
                  {open === pr.id && (
                    <table className="price">
                      <tbody>{Object.entries(pr.by_tool).sort((a, b) => b[1] - a[1]).map(([t, v]) => (
                        <tr key={t}><td>{label(t)}</td><td className="r">{v} 點</td></tr>))}</tbody>
                    </table>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {tab === 'ledger' && (
          <div className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <select value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="all">全部</option>
                <option value="topup">儲值 / 加點</option>
                <option value="free">免費額度</option>
                {sum.projects.map(pr => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
              </select>
            </div>
            <table className="price ledger">
              <tbody>
                {rows.length === 0 && <tr><td className="muted">還沒有紀錄</td></tr>}
                {rows.map((l, i) => (
                  <tr key={i}>
                    <td className="muted small nowrap">{new Date(l.created_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
                    <td>{l.kind === 'charge' ? label(l.reason) : l.kind === 'purchase' ? '儲值' : l.kind === 'grant' ? '加點' : l.kind === 'refund' ? '退點' : l.reason}
                      {l.project_id && <div className="muted small">{projName[l.project_id] ?? ''}</div>}</td>
                    <td className={`r nowrap ${l.delta > 0 ? 'ok' : ''}`}>
                      {l.delta > 0 ? `+${l.delta}` : l.delta < 0 ? `${l.delta}` : ''}
                      {l.waived ? <span className="muted small"> 免 {l.waived}</span> : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'buy' && (
          <div className="card">
            <div className="packs">
              {p.packs.map(k => (
                <div key={k.id} className="pack">
                  <div><b>{k.points} 點</b><div className="muted small">NT${k.twd.toLocaleString()} · 每點 NT${(k.twd / k.points).toFixed(1)} · 約 {Math.floor(k.points / sum.revision_points)} 輪修改或 {(k.points / 39).toFixed(1)} 支新影片</div></div>
                  {k.checkout_url
                    ? <button className="btn primary" onClick={() => buy(k.id)}>購買</button>
                    : <span className="muted small">洽客服</span>}
                </div>
              ))}
            </div>
            {!p.provider_configured && <p className="muted small">{p.note}</p>}
            <table className="price" style={{ marginTop: 12 }}>
              <tbody>{p.menu.map(m => <tr key={m.item}><td>{m.item}</td><td className="r">{m.points} 點</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ k, v, s }: { k: string; v: string; s: string }) {
  return <div className="stat card"><div className="muted small">{k}</div><div className="big">{v}</div><div className="muted small">{s}</div></div>
}
