import { useEffect, useMemo, useState, type DragEvent } from 'react'

/* Upload UI: a drop zone that is also the file picker, and a queue with a real thumbnail per clip,
   per-file progress, overall ring + ETA, retry/remove. State lives in Chat (it owns the network). */
export type Up = {
  id: string; file: File; name: string; size: number; loaded: number
  status: 'wait' | 'up' | 'ok' | 'err'; error?: string; rate?: number   // rate: bytes/s (smoothed)
}
export const MAX_FILES = 30
export const SUGGESTED_FILES = 6
export const MAX_FILE_BYTES = 1024 * 2 ** 20  // 1 GB per file (backend MAX_UPLOAD_MB defaults to the same)
export const fmtMB = (b: number) => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${(b / 2 ** 20).toFixed(b > 100 * 2 ** 20 ? 0 : 1)} MB`
const fmtEta = (s: number) => s < 60 ? `${Math.max(1, Math.round(s))} 秒` : `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, '0')} 秒`

const FilmIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4" /><path d="m11 10 3.5 2-3.5 2z" fill="currentColor" stroke="none" />
  </svg>
)

export function DropZone({ onFiles, onPick, disabled, count = 0, compact = false }:
  { onFiles: (f: FileList | File[] | null) => void; onPick?: () => void; disabled?: boolean; count?: number; compact?: boolean }) {
  const [drag, setDrag] = useState(false)
  const over = (e: DragEvent) => { e.preventDefault(); if (!disabled) setDrag(true) }
  const drop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false)
    if (disabled) return
    const fs = Array.from(e.dataTransfer.files).filter(f => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|jpe?g|png|webp|heic|heif)$/i.test(f.name))
    if (fs.length) onFiles(fs)
  }
  return (
    <label className={`dz ${drag ? 'drag' : ''} ${disabled ? 'off' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={over} onDragEnter={over} onDragLeave={() => setDrag(false)} onDrop={drop}>
      <span className="dz-icon"><FilmIcon /></span>
      <span className="dz-text">
        <b>{disabled ? '上傳中…' : count ? `再加素材（已 ${count} 個）` : drag ? '放開就開始上傳' : '點一下選影片或照片，或直接拖進來'}</b>
        <span className="muted small">影片、照片可以混著給 · 一次建議 {SUGGESTED_FILES} 個、最多 {MAX_FILES} 個 · 每個 1 GB 內</span>
      </span>
      <span className="dz-cta">選擇</span>
      <input type="file" multiple accept="video/*,image/*,.mp4,.mov,.m4v,.jpg,.jpeg,.png,.webp,.heic" hidden disabled={disabled} onClick={onPick}
        onChange={e => { onFiles(e.target.files); e.target.value = '' }} />
    </label>
  )
}

const isImage = (f: File) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)
const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/* A real poster for each clip: the browser decodes a frame a second in, we paint it to a canvas and
   keep the JPEG, so the tile looks the same on every phone (iOS won't paint a paused <video> reliably). */
function Thumb({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file])
  const [poster, setPoster] = useState<string | null>(null)
  const [dur, setDur] = useState<number | null>(null)
  const img = isImage(file)
  useEffect(() => {
    if (img) { setPoster(url); return () => URL.revokeObjectURL(url) }
    const v = document.createElement('video')
    v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url
    let done = false
    const paint = () => {
      if (done || !v.videoWidth) return
      done = true
      const c = document.createElement('canvas'); const s = 160 / Math.max(v.videoWidth, v.videoHeight)
      c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s)
      c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height)
      try { setPoster(c.toDataURL('image/jpeg', .8)) } catch { /* tainted canvas: keep the icon */ }
      v.src = ''
    }
    v.onloadedmetadata = () => { setDur(v.duration); try { v.currentTime = Math.min(1, v.duration / 3) } catch { /* ignore */ } }
    v.onseeked = paint; v.onloadeddata = () => setTimeout(paint, 150)
    return () => { done = true; v.src = ''; URL.revokeObjectURL(url) }
  }, [url, img])
  return (
    <span className={`uq-thumb ${img ? 'photo' : 'clip'} ${poster ? 'has' : ''}`}>
      {poster ? <img src={poster} alt="" /> : <FilmIcon />}
      {!img && <i className="uq-play" />}
      <i className="uq-kind">{img ? '照片' : dur ? fmtClock(dur) : '影片'}</i>
    </span>
  )
}

export function UploadQueue({ ups, onRetry, onRemove, onClose, hint }:
  { ups: Up[]; onRetry: (id: string) => void; onRemove: (id: string) => void; onClose: () => void; hint?: string }) {
  const total = ups.reduce((a, u) => a + u.size, 0)
  const loaded = ups.reduce((a, u) => a + (u.status === 'ok' ? u.size : u.loaded), 0)
  const active = ups.filter(u => u.status === 'up' || u.status === 'wait')
  const ok = ups.filter(u => u.status === 'ok').length
  const failed = ups.filter(u => u.status === 'err').length
  const rate = ups.filter(u => u.status === 'up').reduce((a, u) => a + (u.rate ?? 0), 0)
  const eta = rate > 0 ? (total - loaded) / rate : null
  const pct = total ? Math.min(100, (loaded / total) * 100) : 0
  const busy = active.length > 0
  const R = 15, C = 2 * Math.PI * R
  return (
    <div className={`uq ${busy ? 'busy' : failed ? 'failed' : 'done'}`}>
      <div className="uq-head">
        <span className="uq-ring" aria-hidden="true">
          <svg viewBox="0 0 36 36"><circle cx="18" cy="18" r={R} /><circle cx="18" cy="18" r={R} style={{ strokeDasharray: C, strokeDashoffset: C * (1 - pct / 100) }} /></svg>
          {busy ? <i>{Math.round(pct)}</i> : failed ? <i className="x">!</i> : <i className="ok">✓</i>}
        </span>
        <span className="uq-title">
          <b>{busy ? `上傳中 ${ok}/${ups.length}` : failed ? `${ok} 個完成，${failed} 個失敗` : `${ok} 個素材上傳完成`}</b>
          <span className="muted small">
            {busy ? <>{fmtMB(loaded)} / {fmtMB(total)}{rate > 0 && <> · {fmtMB(rate)}/s</>}{eta !== null && <> · 約剩 {fmtEta(eta)}</>}</> : <>共 {fmtMB(total)}</>}
            {busy && hint ? ` · ${hint}` : ''}
          </span>
        </span>
        {!busy && <a className="small uq-close" onClick={onClose}>關閉</a>}
      </div>
      <div className="uq-list">
        {ups.map(u => {
          const p = u.size ? Math.min(100, (u.loaded / u.size) * 100) : 0
          return (
            <div key={u.id} className={`uq-row ${u.status}`}>
              <Thumb file={u.file} />
              <div className="uq-main">
                <div className="uq-name">{u.name}</div>
                <div className="uq-meta muted small">
                  {u.status === 'wait' && <>排隊中 · {fmtMB(u.size)}</>}
                  {u.status === 'up' && <>{fmtMB(u.loaded)} / {fmtMB(u.size)} · {Math.round(p)}%</>}
                  {u.status === 'ok' && <>完成 · {fmtMB(u.size)}</>}
                  {u.status === 'err' && <span className="uq-err">{u.error || '失敗'}</span>}
                </div>
                <div className="uq-bar"><div style={{ width: `${u.status === 'ok' ? 100 : p}%` }} /></div>
              </div>
              <div className="uq-act">
                {u.status === 'ok' && <span className="uq-check" aria-label="完成">✓</span>}
                {u.status === 'err' && <><a className="small" onClick={() => onRetry(u.id)}>重試</a><a className="small muted" onClick={() => onRemove(u.id)}>移除</a></>}
                {u.status === 'wait' && <a className="small muted" onClick={() => onRemove(u.id)}>移除</a>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
