import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ShareView, type ThreadMsg } from './api'
import logo from './assets/logo.png'
import { MiaoLogo } from './Logo'
import { FbIcon, LineIcon, MessengerIcon, promoText, shareToFacebook, shareToLine, shareToMessenger } from './share'

/* The share page is a small discussion board around one video: the video, then the thread right under it
   (everyone who opens the link — including people it gets forwarded to — sees the same thread), replies
   under comments like Facebook, ready-made fun openers, and the forward buttons below the thread. */
const OPENERS = ['封面好看 👍', '前 3 秒就被勾住了', '價格太香了吧 😳', '想問平日有沒有優惠？', '旁白聲音好聽 🎙', '這段畫面可以再長一點', '幾月去最好？', '帶小孩方便嗎？', '我要揪團 🙋', '音樂好搭']
const pick = (n: number) => { const a = [...OPENERS]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a.slice(0, n) }

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
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [replyText, setReplyText] = useState('')
  const [tip, setTip] = useState('')
  const [openers] = useState(() => pick(4))
  const box = useRef<HTMLTextAreaElement>(null)
  const say = (t: string) => { setTip(t); setTimeout(() => setTip(''), 3500) }
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

  const send = async (parent: number | null, body: string) => {
    if (!body.trim() || busy) return
    setBusy(true); setSendErr('')
    try {
      const r = await api.shareComment(token, name, body, parent)
      setThread(t => [...t, r.comment])
      if (parent === null) setText(''); else { setReplyText(''); setReplyTo(null) }
      try { localStorage.setItem('lk_guest_name', name) } catch { /* ignore */ }
    } catch (e) { setSendErr((e as Error).message) } finally { setBusy(false) }
  }
  const when = (iso: string) => new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
  const tops = useMemo(() => thread.filter(m => !m.parent_id), [thread])
  const repliesOf = (id: number) => thread.filter(m => m.parent_id === id)
  const promo = data ? promoText(data.project_name, location.href, data.signup_points ?? 110) : ''
  const v = data?.versions[0]

  const Msg = ({ m, reply }: { m: ThreadMsg; reply?: boolean }) => (
    <div className={`st-msg ${m.owner ? 'owner' : ''} ${reply ? 'reply' : ''}`}>
      <div className="st-meta"><b>{m.owner ? (m.name || '影片主人') : (m.name || '朋友')}</b>{m.owner && <em>影片主人</em>}<span className="muted small">{when(m.created_at)}</span></div>
      <div className="st-text">{m.text}</div>
      {!reply && !full && <a className="st-reply" onClick={() => { setReplyTo(replyTo === m.id ? null : m.id); setReplyText('') }}>回覆</a>}
    </div>
  )

  return (
    <div className="share-page">
      <header className="share-head">
        <MiaoLogo size={26} />
        <img className="logo share-by" src={logo} alt="人客多 Lakeze" />
        <span className="spacer" />
        <a className="btn small primary" href={data?.signup_url ?? '/signup'}>我也要做</a>
      </header>
      <main className="share-main">
        {err && <div className="card"><b>打不開這個連結</b><div className="muted small">{err}。請跟傳給你的人要新連結。</div></div>}
        {!data && !err && <div className="muted">載入中…</div>}
        {data && (
          <>
            <h1 className="share-title">{data.project_name}</h1>
            {data.note && <p className="share-note">{data.note}</p>}
            {data.versions.length === 0 && <div className="card muted">影片還在準備中，晚點再開。</div>}
            {v?.main && (
              <div className="share-video">
                <video src={v.main.url} controls playsInline preload="metadata" poster={v.poster ?? v.covers[v.covers.length - 1]?.url} />
                {data.allow_download && <a className="btn block" href={`${v.main.url}?download=1`}>下載影片{v.main.meta?.size_mb ? `（${v.main.meta.size_mb} MB）` : ''}</a>}
              </div>
            )}

            <section className="card share-board" id="thread">
              <div className="st-head"><b>💬 大家怎麼說</b><span className="muted small">{thread.length ? `${thread.length} 則` : '還沒有人說話，當第一個'}</span></div>
              {full ? <div className="muted small">留言已滿 {limit} 則。</div> : (
                <div className="st-form top">
                  <div className="st-openers">{openers.map(o => <a key={o} className="chipbtn" onClick={() => { setText(t => (t.trim() ? t.replace(/\s*$/, ' ') : '') + o); box.current?.focus() }}>{o}</a>)}</div>
                  <textarea ref={box} rows={2} placeholder="說說想法、問問題，或幫老闆加油…" value={text} onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(null, text) }} />
                  <div className="st-actions">
                    <input className="st-name" placeholder="你的名字（選填）" value={name} maxLength={40} onChange={e => setName(e.target.value)} />
                    <button className="btn primary" disabled={!text.trim() || busy} onClick={() => send(null, text)}>{busy ? '送出中…' : '送出'}</button>
                  </div>
                  {sendErr && <div className="error">{sendErr}</div>}
                </div>
              )}
              {tops.length > 0 && (
                <div className="st-list board">
                  {tops.map(m => (
                    <div key={m.id} className="st-item">
                      <Msg m={m} />
                      {repliesOf(m.id).length > 0 && <div className="st-replies">{repliesOf(m.id).map(r => <Msg key={r.id} m={r} reply />)}</div>}
                      {replyTo === m.id && (
                        <div className="st-replybox">
                          <input autoFocus placeholder={`回覆 ${m.owner ? (m.name || '影片主人') : (m.name || '朋友')}…`} value={replyText} onChange={e => setReplyText(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(m.id, replyText) }} />
                          <button className="btn primary small" disabled={!replyText.trim() || busy} onClick={() => send(m.id, replyText)}>回覆</button>
                          <a className="small muted" onClick={() => setReplyTo(null)}>取消</a>
                        </div>
                      )}
                    </div>))}
                </div>
              )}
              <div className="share-fwd">
                <div className="share-fwd-h"><b>轉給朋友一起討論</b><span className="muted small">朋友點開也會看到這裡的留言</span></div>
                <div className="share-social">
                  <button className="btn small fb" onClick={() => say(shareToFacebook(location.href, promo, data.fb_app_id) === 'sheet' ? '選「Facebook」就能發文，文案已複製可貼上' : '文案已複製，在 FB 視窗貼上')}><FbIcon /> Facebook</button>
                  <button className="btn small msg" onClick={() => { if (shareToMessenger(location.href, data.fb_app_id) === 'copied') say('連結已複製，貼到 Messenger 對話') }}><MessengerIcon /> Messenger</button>
                  <button className="btn small line" onClick={() => shareToLine(promo)}><LineIcon /> LINE</button>
                  <button className="btn small" onClick={() => { navigator.clipboard?.writeText(location.href); say('連結已複製') }}>複製連結</button>
                </div>
              </div>
            </section>

            {v && v.covers.length > 0 && (
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
            {v && data.allow_download && v.videos.length > 1 && (
              <details className="others"><summary className="small">其他格式</summary>
                {v.videos.filter(x => x !== v.main).map(x => <div key={x.id} className="ver-meta"><span>{x.name}</span><a href={`${x.url}?download=1`}>下載</a></div>)}
              </details>
            )}
            <section className="share-cta">
              <div className="share-cta-k">旅剪 Tripcut 做的</div>
              <h2>你也做一支？</h2>
              <p>丟影片，15 分鐘拿到成品。<br />註冊送 {data.signup_points ?? 110} 點，第一支免費。</p>
              <a className="btn primary lg" href={data.signup_url ?? '/signup'}>免費試做</a>
            </section>
          </>
        )}
      </main>
      {tip && <div className="share-tip">{tip}</div>}
      <footer className="share-foot muted small">旅剪 Tripcut · 人客多 Lakeze</footer>
    </div>
  )
}
