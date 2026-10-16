/* Posting a share link to Facebook / LINE. Facebook no longer accepts pre-filled text, so the promo
   copy is put on the clipboard (and shown for pasting) while the link preview itself carries the
   cover and the offer through Open Graph tags served by /api/og/s/<token>. LINE accepts text. */
export const promoText = (name: string, url: string, points = 220) =>
  `${name} 的短影音出爐 🎬 用「旅剪」15 分鐘自動剪好，旁白、字幕、封面一次搞定。\n你也想試試？註冊送 ${points} 點，第一支免費 👉 ${url}`

export function shareToFacebook(url: string, text: string) {
  navigator.clipboard?.writeText(text).catch(() => {})
  const u = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&hashtag=${encodeURIComponent('#旅剪')}`
  window.open(u, '_blank', 'noopener,width=640,height=560')
}
export function shareToLine(text: string) {
  window.open(`https://line.me/R/share?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
}
export const FbIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.23 2.69.23v2.95h-1.51c-1.49 0-1.96.93-1.96 1.88V12h3.33l-.53 3.47h-2.8v8.38A12 12 0 0 0 24 12z" /></svg>
)
export const LineIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 5.64 2 10.13c0 4.02 3.56 7.39 8.38 8.03.33.07.77.22.88.5.1.26.07.66.03.92l-.14.86c-.04.26-.2 1 .88.55 1.08-.46 5.84-3.44 7.97-5.89C21.47 13.5 22 11.9 22 10.13 22 5.64 17.52 2 12 2zm-3.2 10.7H6.6a.5.5 0 0 1-.5-.5V8.5a.5.5 0 1 1 1 0v3.2h1.7a.5.5 0 1 1 0 1zm1.6-.5a.5.5 0 1 1-1 0V8.5a.5.5 0 1 1 1 0v3.7zm4.4 0a.5.5 0 0 1-.9.3l-1.9-2.6v2.3a.5.5 0 1 1-1 0V8.5a.5.5 0 0 1 .9-.3l1.9 2.6V8.5a.5.5 0 1 1 1 0v3.7zm3.1-2.35a.5.5 0 1 1 0 1h-1.7v.85h1.7a.5.5 0 1 1 0 1h-2.2a.5.5 0 0 1-.5-.5V8.5a.5.5 0 0 1 .5-.5h2.2a.5.5 0 1 1 0 1h-1.7v.85h1.7z" /></svg>
)
