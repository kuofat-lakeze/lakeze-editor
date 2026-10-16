import { useEffect, useState } from 'react'
import { api, type AdminStats, type AdminUser, type AdminUserDetail } from './api'

const TWD_PER_USD = 31

export function Admin() {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [users, setUsers] = useState<AdminUser[]>([])
  const [q, setQ] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [sel, setSel] = useState<AdminUserDetail | null>(null)
  const [msgs, setMsgs] = useState<{ role: string; text?: string; tool?: string }[] | null>(null)

  const load = () => { api.admin.stats().then(setStats); api.admin.users(q).then(setUsers) }
  useEffect(load, [q]) // eslint-disable-line react-hooks/exhaustive-deps
  const open = (id: string) => { setMsgs(null); api.admin.user(id).then(setSel) }

  const grant = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!sel) return
    const f = new FormData(e.currentTarget)
    await api.admin.grant(sel.id, Number(f.get('delta')), String(f.get('reason') || 'manual'), Number(f.get('twd') || 0))
    e.currentTarget.reset(); open(sel.id); load()
  }
  const patch = async (body: Record<string, unknown>) => { if (!sel) return; await api.admin.patch(sel.id, body); open(sel.id); load() }

  const margin = stats && stats.cost_usd > 0 ? ((stats.revenue_twd / TWD_PER_USD - stats.cost_usd) / stats.cost_usd * 100).toFixed(0) : '—'
  return (
    <div className="admin">
      <header><h2>管理後台</h2></header>
      {stats && (
        <div className="stats">
          <Stat k="用戶" v={`${stats.users}`} s={`7 天新增 ${stats.new_users_7d}`} />
          <Stat k="影片輸出" v={`${stats.exports}`} s={`${stats.projects} 個專案`} />
          <Stat k="營收" v={`NT$${stats.revenue_twd.toLocaleString()}`} s={`售出 ${stats.points_sold} 點 · 已用 ${stats.points_used} 點`} />
          <Stat k="API 成本" v={`$${stats.cost_usd}`} s={`Claude $${stats.claude_cost_usd} · ElevenLabs $${stats.eleven_cost_usd}`} />
          <Stat k="免費額度送出" v={`${stats.points_waived} 點`} s={`≈ NT$${(stats.points_waived * 10).toLocaleString()} 價值`} />
          <Stat k="毛利率（對成本）" v={`${margin}%`} s="營收÷成本−1，不含主機" />
        </div>
      )}
      <div className="admin-body">
        <div className="users">
          <div className="row" style={{ marginBottom: 8 }}>
            <input placeholder="搜尋 email" value={q} onChange={e => setQ(e.target.value)} style={{ flex: 1, marginBottom: 0 }} />
            <a className={`chipbtn ${lowOnly ? 'on' : ''}`} onClick={() => setLowOnly(!lowOnly)}>快沒點（&lt;10 點且 7 天內有活動）</a>
          </div>
          <table>
            <thead><tr><th>Email</th><th>餘額</th><th>已付 NT$</th><th>成本 $</th><th>影片</th><th>空間</th><th>最近活動</th><th></th></tr></thead>
            <tbody>
              {users.filter(u => !lowOnly || (u.balance < 10 && u.last_active && Date.now() - Date.parse(u.last_active) < 7 * 86400e3)).map(u => (
                <tr key={u.id} className={sel?.id === u.id ? 'active' : ''} onClick={() => open(u.id)}>
                  <td>{u.email}{u.is_admin && <span className="tag">admin</span>}{u.disabled && <span className="tag err">停用</span>}{u.subscription && <span className="tag">{u.subscription}</span>}</td>
                  <td className="r">{u.balance}</td><td className="r">{u.paid_twd.toLocaleString()}</td>
                  <td className="r">{u.cost_usd}</td><td className="r">{u.exports}/{u.projects}</td>
                  <td className="r muted small">{((u.storage_bytes ?? 0) / 2 ** 30).toFixed(1)}/{Math.round((u.storage_quota_bytes ?? 0) / 2 ** 30)} GB</td>
                  <td className="muted small">{(u.last_active ?? u.created_at).slice(0, 10)}</td>
                  <td className="muted small">{u.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sel && (
          <div className="detail card">
            <div className="modal-head"><h3>{sel.email}</h3><a onClick={() => setSel(null)}>✕</a></div>
            <div className="row">
              <button className="btn small" onClick={() => patch({ disabled: !sel.disabled })}>{sel.disabled ? '啟用' : '停用'}</button>
              <button className="btn small" onClick={() => patch({ is_admin: !sel.is_admin })}>{sel.is_admin ? '取消管理員' : '設為管理員'}</button>
              <button className="btn small" onClick={() => confirm('重設免費專案？下一個新專案會再次免費。') && patch({ reset_free_project: true })}>再送一次免費</button>
            </div>
            <form className="row" onSubmit={grant}>
              <input name="delta" type="number" placeholder="點數 (+/−)" required style={{ width: 110 }} />
              <input name="twd" type="number" placeholder="實收 NT$（選填）" style={{ width: 150 }} />
              <input name="reason" placeholder="備註，如：轉帳 10/14" style={{ flex: 1 }} />
              <button className="btn primary small">加點</button>
            </form>
            <form className="row" onSubmit={async e => {
              e.preventDefault(); const f = new FormData(e.currentTarget); const plan = String(f.get('plan'))
              if (!confirm(plan ? `開通／續約 ${plan}？會入帳該方案的點數並綁定空間。` : '結束訂閱？剩餘的訂閱點數會到期，空間降回免費。')) return
              await api.admin.subscription(sel.id, plan, Number(f.get('subtwd') || 0)); open(sel.id); load()
            }}>
              <select name="plan" defaultValue={sel.subscription || 'sub5'} style={{ width: 120 }}>
                <option value="sub5">旅剪 5</option><option value="sub15">旅剪 15</option><option value="">結束訂閱</option>
              </select>
              <input name="subtwd" type="number" placeholder="實收 NT$" style={{ width: 120 }} />
              <button className="btn small">{sel.subscription ? `訂閱中 ${sel.subscription} · 續約／變更` : '開通訂閱'}</button>
              <input type="number" placeholder="空間上限 GB（0=依方案）" defaultValue={sel.storage_quota_gb ?? ''} style={{ width: 170 }}
                onBlur={e => { const v = Number(e.target.value || 0); if (v !== (sel.storage_quota_gb ?? 0)) patch({ storage_quota_gb: v }) }} />
            </form>
            <textarea rows={2} placeholder="用戶備註" defaultValue={sel.note} onBlur={e => e.target.value !== sel.note && patch({ note: e.target.value })} />
            <h4>專案</h4>
            <table>
              <tbody>{sel.projects.map(p => (
                <tr key={p.id}>
                  <td>{p.name}{p.free && <span className="tag">免費</span>}</td>
                  <td className="r">輸出 {p.exports} · 修改 {p.revision_turns} 輪</td>
                  <td className="r">${p.cost_usd}</td>
                  <td><a onClick={() => api.admin.messages(p.id).then(setMsgs)}>對話</a></td>
                </tr>))}</tbody>
            </table>
            {msgs && (
              <div className="log">{msgs.map((m, i) => <div key={i} className={m.role}>{m.tool ? `🔧 ${m.tool}` : m.text}</div>)}</div>
            )}
            <h4>點數紀錄</h4>
            <table>
              <tbody>{sel.ledger.map(l => (
                <tr key={l.id}>
                  <td className="muted small">{l.created_at.slice(0, 16).replace('T', ' ')}</td>
                  <td>{l.kind} · {l.reason}</td>
                  <td className="r">{l.delta > 0 ? '+' : ''}{l.delta}{l.waived ? ` (免 ${l.waived})` : ''}</td>
                  <td className="r muted">{l.amount_twd ? `NT$${l.amount_twd}` : ''}</td>
                </tr>))}</tbody>
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
