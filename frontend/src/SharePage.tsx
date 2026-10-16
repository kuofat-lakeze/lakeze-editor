import { useEffect, useState } from 'react'
import { api, type ShareView, type ThreadMsg } from './api'
import logo from './assets/logo.png'
import { MiaoLogo } from './Logo'
import { FbIcon, LineIcon, promoText, shareToFacebook, shareToLine } from './share'

export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<ShareView | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState(() => { try { return localStorage.getItem('lk_guest_name') ?? '' } catch { return '' } })
  const [text, setText] = useState('')
  const [thread, setThread] = useState<ThreadMsg[]>([])
  const [full, setFull] = useState(false)
  const [limit, setLimit] = useState(100)
  const [sendErr, setSendErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.share(token).then(d => { setData(d); setThread(d.comments ?? []); setFull(!!d.comments_full); setLimit(d.comments_limit ?? 100) }).catch(e => setErr((e as Error).message || '連結無效'))
  }, [token])
  // Friends talk to each other here: refresh the thread every 20 s while the tab is visible.
  useEffect(() => {
    if (!data) return
    const tick = () => { if (document.visibilityState === 'visible') api.shareThread(token).then(t => { setThread(t.comments); setFull(t.comments_full) }).catch(() => {}) }
    const id = setInterval(tick, 20000); document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick) }
  }, [data, token])

  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true); setSendErr('')
    try {
      const r = await api.shareComment(token, name, text)
      setThread(t => [...t, r.comment]); setText('')
      try { localStorage.setItem('lk_guest_name', name) } catch { /* ignore */ }
    } catch (e) { setSendErr((e as Error).message) } finally { setBusy(false) }
  }
  const when = (iso: string) => new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

  return (
    <div className="share-page">
      <header className="share-head">
        <MiaoLogo size={26} />
        <img className="logo share-by" src={logo} alt="人客多 Lakeze" />
        <span className="spacer" />
        <a className="btn small primary" href={data?.signup_url ?? '/signup'}>我也要試做</a>
      </header>
      <main className="share-main">
        {err && <div className="card"><b>打不開這個連結</b><div className="muted small">{err}。請向提供連結的人索取新的連結。</div></div>}
        {!data && !err && <div className="muted">載入中…</div>}
        {data && (
          <>
            <h1 className="share-title">{data.project_name}</h1>
            {data.note && <p className="share-note">{data.note}</p>}
            {data.versions.length === 0 && <div className="card muted">成品還在準備中，請稍後再開。</div>}
            {data.versions.map(v => (
              <section key={v.version} className="share-ver">
                {v.main && (
                  <div className="share-video">
                    <video src={v.main.url} controls playsInline preload="metadata" poster={v.covers[v.covers.length - 1]?.url} />
                    {data.allow_download && <a className="btn primary block" href={`${v.main.url}?download=1`}>下載影片（1080p{v.main.meta?.size_mb ? `，${v.main.meta.size_mb} MB` : ''}）</a>}
                  </div>
                )}
                <div className="share-social">
                  <span className="muted small">覺得不錯？分享給更多人</span>
                  <button className="btn small fb" onClick={() => shareToFacebook(location.href, promoText(data.project_name, location.href, data.signup_points ?? 220))}><FbIcon /> Facebook</button>
                  <button className="btn small line" onClick={() => shareToLine(promoText(data.project_name, location.href, data.signup_points ?? 220))}><LineIcon /> LINE</button>
                  <button className="btn small" onClick={() => navigator.clipboard?.writeText(location.href)}>複製連結</button>
                </div>
                {v.covers.length > 0 && (
                  <div className="share-covers">
                    <div className="muted small">封面</div>
                    <div className="share-cover-grid">
                      {v.covers.map(c => (
                        <figure key={c.id}>
                          <img src={c.url} alt={c.name} loading="lazy" />
                          {data.allow_download && <a className="btn small block" href={`${c.url}?download=1`}>下載</a>}
                        </figure>
                      ))}
                    </div>
                  </div>
                )}
                {data.allow_download && v.videos.length > 1 && (
                  <details className="others"><summary className="small">其他格式</summary>
                    {v.videos.filter(x => x !== v.main).map(x => <div key={x.id} className="ver-meta"><span>{x.name}</span><a href={`${x.url}?download=1`}>下載</a></div>)}
                  </details>
                )}
              </section>
            ))}
            <section className="card share-comment" id="thread">
              <div className="st-head"><b>大家的留言</b><span className="muted small">{thread.length} / {limit}{thread.length ? '' : ' · 還沒有人留言，當第一個'}</span></div>
              {thread.length > 0 && (
                <div className="st-list">
                  {thread.map(m => (
                    <div key={m.id} className={`st-msg ${m.owner ? 'owner' : ''}`}>
                      <div className="st-meta"><b>{m.owner ? `${m.name || '影片主人'}` : (m.name || '朋友')}</b>{m.owner && <em>影片主人</em>}<span className="muted small">{when(m.created_at)}</span></div>
                      <div className="st-text">{m.text}</div>
                    </div>))}
                </div>
              )}
              {full ? <div className="muted small">留言已達 {limit} 則上限。</div> : (
                <div className="st-form">
                  <input placeholder="你的名字（選填）" value={name} maxLength={40} onChange={e => setName(e.target.value)} />
                  <textarea rows={2} placeholder="看完有什麼想法？例如：封面 B 比較好看、價格字幕再大一點…" value={text} onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }} />
                  {sendErr && <div className="error">{sendErr}</div>}
                  <div className="st-actions"><span className="muted small">留言大家都看得到，影片主人會收到通知。</span><button className="btn primary" disabled={!text.trim() || busy} onClick={send}>{busy ? '送出中…' : '送出'}</button></div>
                </div>
              )}
            </section>
            <section className="share-cta">
              <div className="share-cta-k">這支影片是用旅剪做的</div>
              <h2>你也想做一支？</h2>
              <p>丟影片、說賣點，15 分鐘拿到有旁白、字幕、封面的短影音。註冊送 {data.signup_points ?? 220} 點，第一支免費，不用綁卡。</p>
              <a className="btn primary lg" href={data.signup_url ?? '/signup'}>免費試做第一支</a>
              <a className="small" href="/">先看看怎麼用 →</a>
            </section>
          </>
        )}
      </main>
      <footer className="share-foot muted small">由 <b>Lakeze 人客多</b> · 專業旅遊剪輯 AI 製作</footer>
    </div>
  )
}
