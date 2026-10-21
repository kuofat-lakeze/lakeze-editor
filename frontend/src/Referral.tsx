import { useEffect, useState } from 'react'
import { api, type Referral } from './api'
import { LineIcon, MessengerIcon, shareToLine, shareToMessenger } from './share'
import { IcCheck, IcCopy, IcGift, IcShare } from './icons'

/* 推薦好友: one card that does the whole job — what a friend is worth right now (30 點, or 60 點 while you
   subscribe), the personal link with the share buttons, and the friends list with where each one is.
   The reward lands when the friend finishes their first video, so the list shows that step explicitly.
   Non-subscribers see the 60-點 version as the reason to subscribe. */
const inviteText = (url: string, signup: number) =>
  `我用「旅剪」丟影片 15 分鐘就剪好一支短影音，推薦你試試 🎬\n用我的連結註冊送 ${signup} 點，第一支免費 👉 ${url}`

export function ReferralCard({ onPlans, compact }: { onPlans?: () => void; compact?: boolean }) {
  const [r, setR] = useState<Referral | null>(null)
  const [tip, setTip] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => { api.referral().then(setR).catch(() => {}) }, [])
  const say = (t: string) => { setTip(t); setTimeout(() => setTip(''), 2500) }
  if (!r) return null
  const url = `${location.origin}${r.link}`
  const text = inviteText(url, r.signup_points)
  const now = r.subscribed ? r.points_sub : r.points
  const done = r.friends.filter(f => f.points != null).length
  const waiting = r.friends.filter(f => f.points == null).length
  const copy = () => { navigator.clipboard?.writeText(text).then(() => say('邀請文和連結已複製')).catch(() => say('長按網址複製')) }
  const share = () => {
    if (typeof navigator.share === 'function') navigator.share({ title: '旅剪 Tripcut', text, url }).catch(() => {})
    else copy()
  }
  const when = (iso: string) => { const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z'); return `${d.getMonth() + 1}/${d.getDate()}` }
  return (
    <section className={`card refc ${compact ? 'compact' : ''}`} id="referral-sec">
      <div className="refc-head">
        <div className="refc-k">推薦朋友，拿點數</div>
        <div className="refc-big"><span>每推薦一位</span><b>+{now}</b><small>點</small>{r.subscribed && <em className="refc-x2">訂閱中 ×2</em>}</div>
        <p className="refc-one muted">朋友用你的連結註冊（他拿 {r.signup_points} 點），做出第一支影片時你就拿 {now} 點。</p>
      </div>
      <div className="refc-link v2">
        <div className="refc-urlrow"><span className="refc-url" onClick={copy} title="點一下複製">{url.replace(/^https?:\/\//, '')}</span><button type="button" className="refc-copy" onClick={copy} aria-label="複製連結"><IcCopy size={16} /></button></div>
        <button className="btn primary lg block refc-share" onClick={share}><IcShare size={18} />傳給朋友</button>
        <div className="refc-alt muted small">或直接傳到 <a onClick={() => shareToLine(text)}><LineIcon /> LINE</a> · <a onClick={() => { if (shareToMessenger(url, r.fb_app_id) === 'copied') say('連結已複製，貼到 Messenger') }}><MessengerIcon /> Messenger</a></div>
      </div>
      {!r.subscribed && (
        <a className="refc-up v3" onClick={onPlans}><IcGift size={16} /><span>訂閱後每位變 +{r.points_sub} 點</span><i>›</i></a>
      )}
      {r.friends.length > 0 && (
        <div className="refc-line"><span>{r.friends.length} 位加入 · {done} 位做出影片 · <b>已拿 {r.earned} 點</b></span><a className="small" onClick={() => setOpen(o => !o)}>{open ? '收起' : '看名單'}</a></div>
      )}
      {r.friends.length > 0 && open && (
        <div className="refc-list">
          {r.friends.map((f, i) => (
            <div key={i} className={`refc-row ${f.points != null ? 'is-paid' : f.made_video ? 'is-made' : ''}`}>
              <i className="refc-av" aria-hidden="true">{(f.name || f.email)[0].toUpperCase()}</i>
              <span className="refc-who"><b>{f.name || f.email}</b><small>{when(f.joined_at)} 加入</small></span>
              <span className="refc-st">{f.points != null ? <><IcCheck size={12} /> +{f.points} 點</> : f.made_video ? '影片做好了' : '還沒做第一支'}</span>
            </div>))}
          {waiting > 0 && <div className="muted small">{waiting} 位還沒做出第一支影片，提醒他們一下就有點數進來。</div>}
        </div>
      )}
      {tip && <div className="refc-tip">{tip}</div>}
    </section>
  )
}
