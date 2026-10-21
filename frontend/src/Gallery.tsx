import { useEffect, useState } from 'react'
import { api, verLabel, type GalleryItem } from './api'
import { ShareDialog } from './Deliverables'

export function Gallery({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  const [play, setPlay] = useState<GalleryItem | null>(null)
  const [sharing, setSharing] = useState<GalleryItem | null>(null)
  const [tab, setTab] = useState<'all' | 'final' | 'wip'>('all')
  useEffect(() => { api.gallery().then(setItems) }, [])
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && setPlay(null); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [])
  if (!items) return <div className="center muted">載入中…</div>
  const nFinal = items.filter(i => i.final).length, nWip = items.length - nFinal
  const shown = items.filter(i => tab === 'all' || (tab === 'final' ? i.final : !i.final))
  return (
    <div className="gallery">
      <header><h2>作品庫</h2>
        <div className="seg mini gal-tabs">
          <a className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>全部 {items.length}</a>
          <a className={tab === 'final' ? 'on' : ''} onClick={() => setTab('final')}>已完成 {nFinal}</a>
          <a className={tab === 'wip' ? 'on' : ''} onClick={() => setTab('wip')}>進行中 {nWip}</a>
        </div>
      </header>
      <div className="gallery-body">
        {items.length === 0 && <div className="muted">還沒有輸出過的影片。</div>}
        {items.length > 0 && shown.length === 0 && <div className="muted">{tab === 'final' ? '還沒有標成「完成」的影片。在成品頁按「完成」就會出現在這裡。' : '沒有進行中的影片。'}</div>}
        {tab === 'wip' && shown.length > 0 && <div className="muted small gal-hint">這些影片已經有輸出版本，但還沒按「完成」。開啟專案繼續改，或在成品頁按「完成」。</div>}
        <div className="gal-grid">
          {shown.map(it => (
            <div key={it.project_id} className="gal-item">
              <a className="gal-thumb" onClick={() => (it.video ? setPlay(it) : onOpen(it.project_id))} title={it.video ? '播放' : '開啟專案'}>
                {it.cover ? <img src={it.cover.url} alt={it.name} loading="lazy" /> : it.video ? <video src={it.video.url} preload="metadata" muted playsInline /> : <div className="gal-empty" />}
                <span className={`pill ${it.final ? 'final' : 'wip'}`}>{it.final ? '✓ 完成' : `進行中 · ${verLabel(it.version)}`}</span>
                {it.video && <span className="gal-play" aria-hidden="true" />}
              </a>
              <div className="gal-name">{it.name}</div>
              <div className="gal-meta muted small"><span>{it.updated_at.slice(0, 10)}</span>{it.video && <a onClick={() => setSharing(it)}>分享</a>}<a onClick={() => onOpen(it.project_id)}>開啟</a></div>
            </div>
          ))}
        </div>
      </div>
      {sharing && <ShareDialog projectId={sharing.project_id} version={sharing.version} hasFinal={sharing.final} projectName={sharing.name}
        onClose={() => setSharing(null)} onCreated={() => setSharing(null)} />}
      {play && play.video && (
        <div className="modal-bg gal-bg" onClick={() => setPlay(null)}>
          <div className="gal-player" onClick={e => e.stopPropagation()}>
            <video key={play.video.id} src={play.video.url} controls autoPlay playsInline poster={play.cover?.url} />
            <div className="gal-player-bar">
              <div><b>{play.name}</b><span className="muted small"> · {play.final ? '最終版' : verLabel(play.version)}</span></div>
              <div className="row">
                <button className="btn small primary" onClick={() => setSharing(play)}>分享</button>
                <a className="btn small" href={`${play.video.url}?download=1`} download>下載</a>
                <button className="btn small" onClick={() => { onOpen(play.project_id); setPlay(null) }}>開啟專案</button>
                <a className="gal-close" onClick={() => setPlay(null)}>✕</a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
