/* Posting a share link to Facebook / Messenger / LINE. Facebook no longer accepts pre-filled text, so the
   promo copy is put on the clipboard while the link preview itself carries the cover and the offer through
   Open Graph tags served by /api/og/s/<token>. LINE accepts text.
   On phones a facebook.com share URL lands in a browser that isn't logged in (or the FB app's home), so
   the post never gets composed; the system share sheet hands the link to the FB app's own composer. */
export const promoText = (name: string, url: string, points = 110) =>
  `${name} 的短影音出爐 🎬 用「旅剪 TravelCut」15 分鐘剪好。\n註冊送 ${points} 點，第一支免費 👉 ${url}`

const enc = encodeURIComponent
export const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))
const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}) }
const popup = (u: string) => window.open(u, '_blank', 'noopener,width=640,height=600')

/** 'sheet' = the phone's share sheet opened (pick Facebook there); 'web' = Facebook's share window. */
export function shareToFacebook(url: string, text: string, appId?: string | null): 'sheet' | 'web' {
  copy(text)
  if (isMobile() && typeof navigator.share === 'function') {
    navigator.share({ url }).catch(() => {})
    return 'sheet'
  }
  const tag = enc('#旅剪TravelCut')
  const u = appId
    ? `https://www.facebook.com/dialog/share?app_id=${enc(appId)}&href=${enc(url)}&hashtag=${tag}&display=popup`
    : `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}&hashtag=${tag}`
  if (isMobile()) location.href = u
  else popup(u)
  return 'web'
}

/** Messenger: the app on phones, Facebook's send dialog on computers (needs the app id). */
export function shareToMessenger(url: string, appId?: string | null): 'app' | 'web' | 'copied' {
  if (isMobile()) {
    location.href = `fb-messenger://share/?link=${enc(url)}${appId ? `&app_id=${enc(appId)}` : ''}`
    return 'app'
  }
  if (appId) {
    popup(`https://www.facebook.com/dialog/send?app_id=${enc(appId)}&link=${enc(url)}&redirect_uri=${enc(url)}`)
    return 'web'
  }
  copy(url)
  window.open('https://www.messenger.com/', '_blank', 'noopener')
  return 'copied'
}

export function shareToLine(text: string) {
  window.open(`https://line.me/R/share?text=${enc(text)}`, '_blank', 'noopener')
}

export const FbIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.23 2.69.23v2.95h-1.51c-1.49 0-1.96.93-1.96 1.88V12h3.33l-.53 3.47h-2.8v8.38A12 12 0 0 0 24 12z" /></svg>
)
export const MessengerIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.36 2 2 6.13 2 11.7c0 2.91 1.19 5.44 3.14 7.17.16.15.26.35.27.57l.05 1.78a.8.8 0 0 0 1.12.71l1.99-.88c.17-.07.36-.09.53-.04.91.25 1.89.39 2.9.39 5.64 0 10-4.13 10-9.7S17.64 2 12 2zm6 7.46-2.94 4.66a1.5 1.5 0 0 1-2.17.4l-2.34-1.75a.6.6 0 0 0-.72 0l-3.16 2.4c-.42.32-.97-.18-.69-.63l2.94-4.66a1.5 1.5 0 0 1 2.17-.4l2.34 1.75c.21.16.51.16.72 0l3.16-2.4c.42-.32.97.18.69.63z" /></svg>
)
export const LineIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 5.64 2 10.13c0 4.02 3.56 7.39 8.38 8.03.33.07.77.22.88.5.1.26.07.66.03.92l-.14.86c-.04.26-.2 1 .88.55 1.08-.46 5.84-3.44 7.97-5.89C21.47 13.5 22 11.9 22 10.13 22 5.64 17.52 2 12 2zm-3.2 10.7H6.6a.5.5 0 0 1-.5-.5V8.5a.5.5 0 1 1 1 0v3.2h1.7a.5.5 0 1 1 0 1zm1.6-.5a.5.5 0 1 1-1 0V8.5a.5.5 0 1 1 1 0v3.7zm4.4 0a.5.5 0 0 1-.9.3l-1.9-2.6v2.3a.5.5 0 1 1-1 0V8.5a.5.5 0 0 1 .9-.3l1.9 2.6V8.5a.5.5 0 1 1 1 0v3.7zm3.1-2.35a.5.5 0 1 1 0 1h-1.7v.85h1.7a.5.5 0 1 1 0 1h-2.2a.5.5 0 0 1-.5-.5V8.5a.5.5 0 0 1 .5-.5h2.2a.5.5 0 1 1 0 1h-1.7v.85h1.7z" /></svg>
)
