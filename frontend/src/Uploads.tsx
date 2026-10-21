import { IcTimer, IcWifi } from './icons'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

/* Upload UI: a drop zone that is also the file picker, and a queue with a real thumbnail per clip,
   per-file progress, overall ring + ETA, retry/remove. State lives in Chat (it owns the network). */
export type Up = {
  id: string; file: File; name: string; size: number; loaded: number
  status: 'wait' | 'up' | 'ok' | 'err' | 'del'; error?: string; rate?: number   // rate: bytes/s (smoothed); del = being deleted
  server?: string   // file name on the server once uploaded
}
export const MAX_FILES = 30
const MOBILE_DZ = typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/.test(navigator.userAgent)
/** Videos kept in iCloud / Google Photos are downloaded to the phone before the browser gets them: ~15 s each. */
export const CLOUD_SECS_PER_VIDEO = 15

/* A cloud dropping a stream of dots into a phone: "your phone is fetching the originals from the cloud". */
export const CloudDl = ({ small = false }: { small?: boolean }) => (
  <span className={`cdl ${small ? 'sm' : ''}`} aria-hidden="true">
    <svg viewBox="0 0 64 64" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path className="cdl-cloud" d="M19 27a10 10 0 0 1 1.2-19.9A13 13 0 0 1 45 9.5 9 9 0 0 1 46 27z" />
      <path className="cdl-arrow" d="M32 14v9m-4-4 4 4 4-4" />
      <rect className="cdl-phone" x="21" y="36" width="22" height="26" rx="4" />
      <path className="cdl-notch" d="M29 39h6" />
      <rect className="cdl-fill" x="24" y="43" width="16" height="15" rx="1.5" />
    </svg>
    <i /><i /><i />
  </span>
)
export const SUGGESTED_FILES = 6
export const MAX_FILE_BYTES = 1024 * 2 ** 20  // 1 GB per file (backend MAX_UPLOAD_MB defaults to the same)
export const fmtMB = (b: number) => b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(2)} GB` : `${(b / 2 ** 20).toFixed(b > 100 * 2 ** 20 ? 0 : 1)} MB`
const fmtEta = (s: number) => s < 60 ? `${Math.max(1, Math.round(s))} 秒` : `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, '0')} 秒`

const FilmIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="3" /><path d="M7 5v14M17 5v14M3 10h4M3 14h4M17 10h4M17 14h4" /><path d="m11 10 3.5 2-3.5 2z" fill="currentColor" stroke="none" />
  </svg>
)

const IOS_PICK = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent)
const GUIDE_KEY = 'lk_pick_guide_seen'
const guideOff = () => { try { return localStorage.getItem(GUIDE_KEY) === 'off' } catch { return true } }
const guideHide = () => { try { localStorage.setItem(GUIDE_KEY, 'off') } catch { /* private mode */ } }
/** iPhone: show the picture guide every time the picker opens, until the person ticks 不再顯示. */
export const needsPickGuide = () => IOS_PICK && !guideOff()

/* iPhone's photo picker freezes for a few seconds after the blue ✓ while it prepares (or downloads from
   iCloud) the videos, and the ✓ looks like nothing happened. The page can't draw over the picker, so the
   picture guide comes first: pick → tap ✓ → it pauses, that's normal → it comes back and uploads. */
/* One picture, one animation: the hand taps the picker's blue ✓, a ring fills around it while the screen
   dims (that's the wait), then it turns into an upload arrow. Loops; pure CSS. */
export function PickGuide({ onGo, onClose }: { onGo: () => void; onClose: () => void }) {
  const [hide, setHide] = useState(false)
  return (
    <div className="pg-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pg" role="dialog" aria-label="按勾勾後等它跑完">
        <div className="pg1" aria-hidden="true">
          <div className="pg1-phone">
            <div className="pg1-bar"><i className="pg1-back" /><span /><i className="pg1-ok"><svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" /></svg></i></div>
            <div className="pg1-grid">{[0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => <i key={i} className={i === 1 || i === 5 ? 'sel' : ''}>{(i === 1 || i === 5) && <b className="pg1-cloud" />}</i>)}</div>
            <em className="pg1-hand">👆</em>
          </div>
        </div>
        <p className="pg1-line">按 <span className="pg1-chip">✓</span> 後，<span className="pg1-chip dim">✓</span> 變淡＝正在下載，等它跑完</p>
        <div className="pg-facts">
          <span><i className="pg-ic"><IcWifi size={15} /></i>網路要穩</span>
          <span><i className="pg-ic"><IcTimer size={15} /></i>1 分鐘影片 ≈ 等 15 秒</span>
        </div>
        <button type="button" className="btn primary block pg-go" onClick={() => { if (hide) guideHide(); onClose(); onGo() }}>知道了，選影片</button>
        <label className="pg-hide"><input type="checkbox" checked={hide} onChange={e => setHide(e.target.checked)} />之後不再顯示</label>
      </div>
    </div>
  )
}

export function DropZone({ onFiles, onPick, disabled, count = 0, compact = false }:
  { onFiles: (f: FileList | File[] | null) => void; onPick?: () => void; disabled?: boolean; count?: number; compact?: boolean }) {
  const [drag, setDrag] = useState(false)
  const [guide, setGuide] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const bypass = useRef(false)   // the click the guide forwards to the input must not open the guide again
  const over = (e: DragEvent) => { e.preventDefault(); if (!disabled) setDrag(true) }
  const drop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false)
    if (disabled) return
    const fs = Array.from(e.dataTransfer.files).filter(f => /^(video|image)\//.test(f.type) || /\.(mp4|mov|m4v|jpe?g|png|webp|heic|heif)$/i.test(f.name))
    if (fs.length) onFiles(fs)
  }
  return (<>
    <label className={`dz ${drag ? 'drag' : ''} ${disabled ? 'off' : ''} ${compact ? 'compact' : ''}`}
      onDragOver={over} onDragEnter={over} onDragLeave={() => setDrag(false)} onDrop={drop}
      onClick={e => { if (bypass.current) { bypass.current = false; return } if (!disabled && needsPickGuide()) { e.preventDefault(); setGuide(true) } }}>
      <span className="dz-icon"><FilmIcon /></span>
      <span className="dz-text">
        <b>{disabled ? '上傳中…' : count ? `再加素材（已 ${count} 個）` : drag ? '放開就上傳' : '選影片或照片'}</b>
        <span className="dz-kinds" aria-label="影片、照片、可多選">🎞 影片 · 📷 照片 · 可多選<em className="dz-many">超過 {MAX_FILES} 個 → 貼雲端連結</em></span>
        {MOBILE_DZ && !disabled && !count && <span className="dz-ios"><CloudDl small /><span>iCloud 影片每支約等 {CLOUD_SECS_PER_VIDEO} 秒</span></span>}
      </span>
      <span className="dz-cta">選擇</span>
      <input ref={input} type="file" multiple accept="video/*,image/*,.mp4,.mov,.m4v,.jpg,.jpeg,.png,.webp,.heic" hidden disabled={disabled} onClick={onPick}
        onChange={e => { onFiles(e.target.files); e.target.value = '' }} />
    </label>
    {guide && <PickGuide onGo={() => { bypass.current = true; input.current?.click() }} onClose={() => setGuide(false)} />}
  </>)
}

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
)

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

export function UploadQueue({ ups, onRetry, onRemove, onDelete, onClose, hint }:
  { ups: Up[]; onRetry: (id: string) => void; onRemove: (id: string) => void; onDelete?: (id: string) => void; onClose: () => void; hint?: string }) {
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
          <b>{!busy && !ups.length ? '素材都刪掉了' : busy ? `上傳中 ${ok}/${ups.length}` : failed ? `${ok} 個完成，${failed} 個失敗` : `${ok} 個素材上傳完成`}</b>
          <span className="muted small">
            {busy ? <>{fmtMB(loaded)} / {fmtMB(total)}{eta !== null && <> · 約剩 {fmtEta(eta)}</>}</> : <>共 {fmtMB(total)}</>}
            {busy && hint ? <span className="uq-hint">📱 {hint}</span> : null}
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
                  {u.status === 'del' && <>刪除中…</>}
                  {u.status === 'err' && <span className="uq-err">{u.error || '失敗'}</span>}
                </div>
                <div className="uq-bar"><div style={{ width: `${u.status === 'ok' ? 100 : p}%` }} /></div>
              </div>
              <div className="uq-act">
                {u.status === 'ok' && <span className="uq-check" aria-label="完成">✓</span>}
                {u.status === 'ok' && onDelete && <button type="button" className="uq-del" title="刪掉這個素材" aria-label={`刪掉 ${u.name}`} onClick={() => onDelete(u.id)}><TrashIcon /></button>}
                {u.status === 'del' && <span className="spinner" />}
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
