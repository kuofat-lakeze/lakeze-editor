import { useEffect, useState } from 'react'
import { api, type ShareView } from './api'
import logo from './assets/logo.png'

export function SharePage({ token }: { token: string }) {
  const [data, setData] = useState<ShareView | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [sent, setSent] = useState(false)
  useEffect(() => { api.share(token).then(setData).catch(e => setErr((e as Error).message || '連結無效')) }, [token])

  const send = async () => {
    if (!text.trim()) return
    await api.shareComment(token, name, text)
    setSent(true); setText('')
  }

  return (
    <div className="share-page">
      <header className="share-head">
        <img className="logo" src={logo} alt="Lakeze 人客多" />
        <span className="share-tag">專業旅遊剪輯 AI</span>
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
            <section className="card share-comment">
              <b>看完有想法？留話給他</b>
              <span className="muted small">你的留言會直接送到影片主人的「朋友的反饋」。</span>
              {sent ? <div className="ok">已送出，謝謝！對方會收到通知。</div> : (
                <>
                  <input placeholder="你的名字（選填）" value={name} onChange={e => setName(e.target.value)} />
                  <textarea rows={3} placeholder="例如：價格字幕再大一點、第二段換成泳池畫面…" value={text} onChange={e => setText(e.target.value)} />
                  <button className="btn primary" disabled={!text.trim()} onClick={send}>送出</button>
                </>
              )}
            </section>
            <section className="share-cta">
              <div className="share-cta-k">這支影片是用旅剪做的</div>
              <h2>你也想做一支？</h2>
              <p>丟影片、說賣點，15 分鐘拿到有旁白、字幕、封面的短影音。註冊送 {data.signup_points ?? 110} 點，第一支免費，不用綁卡。</p>
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
