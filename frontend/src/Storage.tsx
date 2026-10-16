import { useEffect, useState } from 'react'
import { api, type StorageInfo, type StorageState } from './api'

export const fmtBytes = (b: number) => {
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(b >= 10 * 2 ** 30 ? 0 : 1)} GB`
  if (b >= 2 ** 20) return `${Math.round(b / 2 ** 20)} MB`
  return `${Math.max(0, Math.round(b / 1024))} KB`
}
const gb = (b: number) => Math.round(b / 2 ** 30)
const PER_VIDEO = 110 * 2 ** 20   // a 60 s 1080p vertical export with its master and preview ≈ 110 MB

/* Thin usage bar: used in the 成品 tab header, the sidebar and the plans page. */
export function StorageMeter({ s, onManage, compact = false }: { s: StorageState; onManage?: () => void; compact?: boolean }) {
  const pct = s.quota_bytes ? Math.min(100, (s.used_bytes / s.quota_bytes) * 100) : 0
  const tone = s.over ? 'over' : pct > 85 ? 'warn' : ''
  return (
    <div className={`smeter ${tone} ${compact ? 'compact' : ''}`}>
      <div className="smeter-row">
        <span className="smeter-label">成品空間</span>
        <span className="smeter-num"><b>{fmtBytes(s.used_bytes)}</b> / {gb(s.quota_bytes)} GB</span>
        {onManage && <a className="small" onClick={onManage}>{s.over ? '空間已滿，管理' : '管理'}</a>}
      </div>
      <div className="smeter-bar"><div style={{ width: `${pct}%` }} /></div>
      {!compact && s.over && <div className="smeter-note">已滿：新的影片與封面輸出會先暫停。刪掉舊版本或升級方案就能繼續，已有的成品照常可看可下載。</div>}
    </div>
  )
}

/* Storage block on the plans page: meter, the three sizes, per-project usage. */
export function StorageInline({ subscribed, onChanged, onOpenProject }: { subscribed?: boolean; onChanged?: () => void; onOpenProject?: (id: string) => void }) {
  const [s, setS] = useState<StorageInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const load = () => api.storage().then(setS)
  useEffect(() => { load() }, [])
  if (!s) return <div className="muted small">載入空間用量…</div>
  const videosLeft = Math.max(0, Math.floor((s.quota_bytes - s.used_bytes) / PER_VIDEO))
  const choose = async (id: string) => {
    const p = s.plans.find(x => x.id === id)!
    const msg = p.points
      ? `成品空間改成 ${p.label}：現在扣 ${p.points} 點，之後每 ${s.period_days} 天自動續扣 ${p.points} 點（NT$${p.twd}）。確定？`
      : `降回免費 2 GB？這個月已付的不退，檔案都會留著；若用量超過 2 GB，新的輸出會暫停直到清出空間。`
    if (!confirm(msg)) return
    setBusy(id); setErr('')
    try { await api.setStoragePlan(id); await load(); onChanged?.() } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <div className="sinline">
      <div className="sinline-head">
        <div><b>成品空間</b><div className="muted small">只算成品頁裡的影片與封面（每一版都算）；原始素材不計，閒置 {s.raw_retention_days} 天後自動清除。</div></div>
        <span className="muted small">{s.over ? '已滿' : `還可放約 ${videosLeft} 支`}</span>
      </div>
      <StorageMeter s={s} />
      <div className="sinline-plans">
        {s.plans.map(p => {
          const cur = p.id === s.plan
          const bundled = subscribed && cur && !s.renews_at
          return (
            <div key={p.id} className={`splan ${cur ? 'cur' : ''}`}>
              <div className="splan-gb">{p.gb}<small>GB</small></div>
              <div className="splan-price">{p.points ? <>{p.points} 點<span className="muted small"> / {s.period_days} 天</span></> : '免費'}</div>
              <div className="muted small">約 {Math.floor(p.gb * 2 ** 30 / PER_VIDEO)} 支影片</div>
              {cur ? <span className="pill">{bundled ? '訂閱內含' : '目前'}</span>
                : <button className="btn small" disabled={busy !== null} onClick={() => choose(p.id)}>{busy === p.id ? '處理中…' : p.points > (s.plans.find(x => x.id === s.plan)?.points ?? 0) ? '升級' : '改用'}</button>}
            </div>
          )
        })}
      </div>
      {err && <div className="error">{err}</div>}
      {s.projects.length > 0 && (
        <details className="sinline-proj">
          <summary className="small">各專案用量（{s.projects.length} 個）</summary>
          <div className="tool-rows">
            {s.projects.map(p => (
              <div key={p.id} className="tool-row sproj" onClick={() => onOpenProject?.(p.id)}>
                <span><b style={{ fontWeight: 600 }}>{p.name}</b><span className="muted small"> · {p.versions} 版{p.final_version ? ` · 最終版 v${p.final_version}` : ''}</span></span>
                <div className="sproj-bar"><div style={{ width: `${s.used_bytes ? (p.bytes / s.used_bytes) * 100 : 0}%` }} /></div>
                <b>{fmtBytes(p.bytes)}</b>
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 6 }}>要清空間：到專案的「成品」頁刪掉不要的舊版本；標了最終版的那一版不會被刪。</div>
        </details>
      )}
    </div>
  )
}
