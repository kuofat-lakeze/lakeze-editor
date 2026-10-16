import { useEffect, useState } from 'react'
import { api, type GalleryItem } from './api'

export function Gallery({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [items, setItems] = useState<GalleryItem[] | null>(null)
  useEffect(() => { api.gallery().then(setItems) }, [])
  if (!items) return <div className="center muted">載入中…</div>
  return (
    <div className="gallery">
      <header><h2>作品庫</h2><span className="muted small">{items.length} 支影片</span></header>
      <div className="gallery-body">
        {items.length === 0 && <div className="muted">還沒有輸出過的影片。</div>}
        <div className="gal-grid">
          {items.map(it => (
            <a key={it.project_id} className="gal-item" onClick={() => onOpen(it.project_id)}>
              <div className="gal-thumb">
                {it.cover ? <img src={it.cover.url} alt={it.name} loading="lazy" /> : it.video ? <video src={it.video.url} preload="metadata" muted playsInline /> : <div className="gal-empty" />}
                <span className={`pill ${it.final ? 'final' : ''}`}>{it.final ? '最終版' : `v${it.version}`}</span>
              </div>
              <div className="gal-name">{it.name}</div>
              <div className="muted small">{it.updated_at.slice(0, 10)}</div>
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}
