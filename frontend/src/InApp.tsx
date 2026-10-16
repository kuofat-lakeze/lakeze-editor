import { useState } from 'react'

/* LINE / Facebook / Instagram open links in their own in-app browser, which can't pick videos
   reliably and loses the login. LINE honours ?openExternalBrowser=1 and hands the page to Safari /
   Chrome by itself, so we try that first; when we are still inside an in-app browser we show a
   picture of exactly what to tap. */
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
export const IN_LINE = /\bLine\//i.test(UA)
export const IN_FB = /FBAN|FBAV|FB_IAB|Instagram/i.test(UA)
export const IN_APP_BROWSER = IN_LINE || IN_FB || /MicroMessenger/i.test(UA)
const IOS = /iPhone|iPad|iPod/.test(UA)

/** Call once at start-up. Returns true if we are leaving for the external browser. */
export function escapeLine(): boolean {
  if (!IN_LINE) return false
  if (location.pathname.startsWith('/s/')) return false          // friends just watching a video can stay
  const u = new URL(location.href)
  if (u.searchParams.get('openExternalBrowser') === '1') return false   // already tried once
  u.searchParams.set('openExternalBrowser', '1')
  location.replace(u.toString())
  return true
}

export function InAppGuide({ compact = false }: { compact?: boolean }) {
  const [hide, setHide] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!IN_APP_BROWSER || hide) return null
  const app = IN_LINE ? 'LINE' : /Instagram/i.test(UA) ? 'Instagram' : IN_FB ? 'Facebook' : '這個 App'
  const browser = IOS ? 'Safari' : 'Chrome'
  const url = location.href.replace(/[?&]openExternalBrowser=1/, '')
  const copy = () => { navigator.clipboard?.writeText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) }).catch(() => {}) }
  if (compact) return (
    <div className="iab-bar" onClick={() => setHide(false)}>
      <span>⚠️ 你在 {app} 裡開啟，上傳影片容易失敗</span><b>改用 {browser} 開 →</b>
    </div>
  )
  return (
    <div className="iab">
      <div className="iab-arrow" aria-hidden="true"><span>點這裡</span><i>↗</i></div>
      <div className="iab-card">
        <b className="iab-title">請用 {browser} 開啟旅剪</b>
        <p className="iab-sub">你現在是在 {app} 裡面打開的。{app} 的內建視窗常常選不到影片、也會登出，換到 {browser} 就順了。</p>
        <ol className="iab-steps">
          <li><i>1</i><span>點右上角的 <em className="iab-dots">⋯</em>{IN_LINE ? '（或右下角的分享圖示）' : ''}</span></li>
          <li><i>2</i><span>選「<b>{IN_LINE ? '以預設瀏覽器開啟' : `在 ${browser} 中開啟`}</b>」{IN_LINE ? '或「在 Safari 開啟」' : '或「以外部瀏覽器開啟」'}</span></li>
          <li><i>3</i><span>在 {browser} 裡繼續，帳號和專案都在</span></li>
        </ol>
        <div className="iab-mock" aria-hidden="true">
          <div className="iab-mock-bar"><span>editor.lakeze.com</span><em>⋯</em></div>
          <div className="iab-mock-menu"><div>分享</div><div className="hi">{IN_LINE ? '以預設瀏覽器開啟' : `在 ${browser} 中開啟`}</div><div>複製連結</div></div>
        </div>
        <button className="btn block" onClick={copy}>{copied ? '已複製，貼到瀏覽器網址列即可' : '找不到？複製網址自己貼到瀏覽器'}</button>
        <a className="small iab-skip" onClick={() => setHide(true)}>先在這裡看看就好</a>
      </div>
    </div>
  )
}
