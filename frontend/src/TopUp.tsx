import { useEffect, useState } from 'react'
import { api, type Ledger, type Pricing } from './api'

export function TopUp({ balance, onClose }: { balance: number; onClose: () => void }) {
  const [p, setP] = useState<Pricing | null>(null)
  const [ledger, setLedger] = useState<Ledger[]>([])
  const [tab, setTab] = useState<'buy' | 'price' | 'history'>('buy')
  useEffect(() => { api.pricing().then(setP); api.credits().then(r => setLedger(r.ledger)) }, [])

  const buy = async (id: string) => {
    const { url } = await api.checkout(id)
    window.open(url, '_blank')
  }
  if (!p) return null
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal card" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h3>點數 <span className="muted small">餘額 {balance} 點</span></h3>
          <a onClick={onClose}>✕</a>
        </div>
        <div className="tabs">
          <a className={tab === 'buy' ? 'active' : ''} onClick={() => setTab('buy')}>儲值</a>
          <a className={tab === 'price' ? 'active' : ''} onClick={() => setTab('price')}>價目</a>
          <a className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>紀錄</a>
        </div>
        {tab === 'buy' && (
          <div className="packs">
            {p.packs.map(k => (
              <div key={k.id} className="pack">
                <div><b>{k.points} 點</b><div className="muted small">NT${k.twd.toLocaleString()} · 每點 NT${(k.twd / k.points).toFixed(1)}</div></div>
                {k.checkout_url
                  ? <button className="btn primary" onClick={() => buy(k.id)}>購買</button>
                  : <span className="muted small">洽客服</span>}
              </div>
            ))}
            {!p.provider_configured && <p className="muted small">{p.note}</p>}
            <p className="muted small">1 點 = NT${p.point_twd}。第一個專案：第一版 + 封面 + {p.free_revision_turns} 輪修改免費。點數不過期。</p>
          </div>
        )}
        {tab === 'price' && (
          <table className="price">
            <tbody>{p.menu.map(m => <tr key={m.item}><td>{m.item}</td><td className="r">{m.points} 點</td></tr>)}</tbody>
          </table>
        )}
        {tab === 'history' && (
          <table className="price">
            <tbody>
              {ledger.length === 0 && <tr><td className="muted">還沒有紀錄</td></tr>}
              {ledger.map((l, i) => (
                <tr key={i}>
                  <td>{new Date(l.created_at).toLocaleString('zh-TW', { hour12: false })}</td>
                  <td>{l.reason}{l.waived ? <span className="muted"> （免費額度 {l.waived} 點）</span> : ''}</td>
                  <td className={`r ${l.delta > 0 ? 'ok' : ''}`}>{l.delta > 0 ? '+' : ''}{l.delta || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
