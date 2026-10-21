import { useEffect, useState } from 'react'

/* 版本檢查: the bundle knows its build id; /version.json says which build the server serves now. When they
   differ (a deploy landed while the tab was open) a bar offers a reload — never forced, so nothing in
   progress is lost. Checked on an interval and whenever the tab comes back to the front. */
export function VersionBar() {
  const [stale, setStale] = useState(false)
  useEffect(() => {
    let dead = false
    const check = async () => {
      try { const r = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) return; const j = await r.json(); if (!dead && j.build && j.build !== __BUILD_ID__) setStale(true) } catch { /* offline: ignore */ }
    }
    const iv = setInterval(check, 90000)
    const vis = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', vis)
    const first = setTimeout(check, 15000)
    return () => { dead = true; clearInterval(iv); clearTimeout(first); document.removeEventListener('visibilitychange', vis) }
  }, [])
  if (!stale) return null
  return (
    <div className="verbar" role="status">
      <span>🆕 有新版本</span>
      <button type="button" className="btn primary small" onClick={() => location.reload()}>重新整理取用</button>
      <a className="small" onClick={() => setStale(false)}>稍後</a>
    </div>
  )
}
