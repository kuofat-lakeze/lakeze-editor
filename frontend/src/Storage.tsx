import { useEffect, useState } from 'react'
import { api, type StorageInfo, type StorageState } from './api'

export const fmtBytes = (b: number) => {
  if (b >= 2 ** 30) return `${(b / 2 ** 30).toFixed(b >= 10 * 2 ** 30 ? 0 : 1)} GB`
  if (b >= 2 ** 20) return `${Math.round(b / 2 ** 20)} MB`
  return `${Math.max(0, Math.round(b / 1024))} KB`
}
const gb = (b: number) => Math.round(b / 2 ** 30)

/* Thin usage bar: used in the 成品 tab header, the sidebar and the storage page. */
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

/* Storage page (a tab inside 點數): usage, per-project breakdown, plans. */
export function StoragePanel({ onChanged, onOpenProject }: { onChanged?: () => void; onOpenProject?: (id: string) => void }) {
  const [s, setS] = useState<StorageInfo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const load = () => api.storage().then(setS)
  useEffect(() => { load() }, [])
  if (!s) return <div className="center muted">載入中…</div>
  const cur = s.plans.find(p => p.id === s.plan) ?? s.plans[0]
  const pct = s.quota_bytes ? Math.min(100, (s.used_bytes / s.quota_bytes) * 100) : 0
  const perVideo = 110 * 2 ** 20   // a 60 s 1080p vertical export with its master and preview ≈ 110 MB
  const videosLeft = Math.max(0, Math.floor((s.quota_bytes - s.used_bytes) / perVideo))
  const choose = async (id: string) => {
    const p = s.plans.find(x => x.id === id)!
    const msg = p.points
      ? `切換到「${p.label}」：現在扣 ${p.points} 點，之後每 ${s.period_days} 天自動續扣 ${p.points} 點（NT$${p.twd}）。確定？`
      : `降回免費 2 GB？這個月已付的不退，檔案都會留著；若用量超過 2 GB，新的輸出會暫停直到清出空間。`
    if (!confirm(msg)) return
    setBusy(id); setErr('')
    try { await api.setStoragePlan(id); await load(); onChanged?.() } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  return (
    <>
      <section className={`hero card storage-hero ${s.over ? 'low' : ''}`}>
        <div className="hero-main">
          <div className="eyebrow">成品空間</div>
          <div className="hero-num">{fmtBytes(s.used_bytes).replace(/ (GB|MB|KB)$/, '')}<span className="unit">{fmtBytes(s.used_bytes).split(' ')[1]} / {gb(s.quota_bytes)} GB</span></div>
          <div className="hero-sub">
            {s.over ? '空間已滿，新的輸出會先暫停。' : <>還可以放約 <b>{videosLeft}</b> 支影片</>}
            {' · '}目前方案 <b>{cur.label}</b>{cur.points ? `，每 ${s.period_days} 天 ${cur.points} 點` : ''}
            {s.renews_at && <>，下次續扣 {s.renews_at.slice(5, 10).replace('-', '/')}</>}
          </div>
          <div className={`smeter ${s.over ? 'over' : pct > 85 ? 'warn' : ''}`} style={{ marginTop: 12 }}><div className="smeter-bar"><div style={{ width: `${pct}%` }} /></div></div>
        </div>
        <div className="hero-side">
          <span className="muted small">餘額 {s.balance} 點</span>
        </div>
        <div className="hero-foot">
          <span>只計算「成品」頁裡的影片與封面（每一版都算）</span>
          <span className="dot-sep" />
          <span>原始素材不計，閒置 {s.raw_retention_days} 天後自動清除</span>
        </div>
      </section>

      <section className="packs-grid splans">
        {s.plans.map(p => {
          const isCur = p.id === s.plan
          const best = p.id === 's100'
          return (
            <div key={p.id} className={`packc card ${isCur ? 'cur' : ''} ${best ? 'best' : ''}`}>
              {best && !isCur && <div className="ribbon">最多人選</div>}
              {isCur && <div className="ribbon cur">目前方案</div>}
              <div className="packc-pts">{p.gb}<span className="unit">GB</span></div>
              <div className="packc-price">{p.points ? <>{p.points} 點 <span className="muted small">/ {s.period_days} 天 · NT${p.twd}</span></> : '免費'}</div>
              <div className="muted small">約放 {Math.floor(p.gb * 2 ** 30 / perVideo)} 支影片{p.extra_gb ? `（免費 2 GB ＋ ${p.extra_gb} GB）` : ''}</div>
              <button className={`btn block ${isCur ? '' : p.points > cur.points ? 'primary' : ''}`} disabled={isCur || busy !== null} onClick={() => choose(p.id)}>
                {isCur ? '使用中' : busy === p.id ? '處理中…' : p.points > cur.points ? '升級' : '改用這個'}
              </button>
            </div>
          )
        })}
      </section>
      {err && <div className="error">{err}</div>}

      <section className="card">
        <b>各專案用量</b>
        {s.projects.length === 0 && <div className="muted small" style={{ marginTop: 6 }}>還沒有成品。</div>}
        <div className="tool-rows">
          {s.projects.map(p => (
            <div key={p.id} className="tool-row sproj" onClick={() => onOpenProject?.(p.id)}>
              <span><b style={{ fontWeight: 600 }}>{p.name}</b><span className="muted small"> · {p.versions} 版{p.final_version ? ` · 最終版 v${p.final_version}` : ''}</span></span>
              <div className="sproj-bar"><div style={{ width: `${s.used_bytes ? (p.bytes / s.used_bytes) * 100 : 0}%` }} /></div>
              <b>{fmtBytes(p.bytes)}</b>
            </div>
          ))}
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>要清空間：到專案的「成品」頁刪掉不要的舊版本；標了最終版的那一版不會被刪。</div>
      </section>

      <section className="howto muted small">
        升級立即生效並從點數扣款，之後每 {s.period_days} 天自動續扣；點數不夠時方案會降回免費，檔案保留、可看可下載，只是暫停新的輸出。降級隨時可以，當期已付不退。
      </section>
    </>
  )
}
