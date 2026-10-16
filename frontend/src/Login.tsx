import { useEffect, useState } from 'react'
import { api, type Me, type Providers } from './api'
import logo from './assets/logo.png'
import { MiaoLogo } from './Logo'

const STEPS = [
  { n: '1', t: '給素材', d: '上傳手機拍的影片、照片，或貼 Google Drive 連結' },
  { n: '2', t: '先解析，看賣點', d: '剪輯師看完素材，列出賣點、分鏡、旁白稿和要花的點數' },
  { n: '3', t: '選風格、開始剪', d: '一路做到輸出影片與封面，再分享給朋友' },
]

const GoogleIcon = () => (
  <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
)
const FacebookIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path fill="#1877F2" d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.23 2.69.23v2.95h-1.51c-1.49 0-1.96.93-1.96 1.88V12h3.33l-.53 3.47h-2.8v8.38A12 12 0 0 0 24 12z" />
    <path fill="#fff" d="M16.67 15.47 17.2 12h-3.33V9.75c0-.95.47-1.88 1.96-1.88h1.51V4.92s-1.38-.23-2.69-.23c-2.74 0-4.53 1.66-4.53 4.67V12H7.08v3.47h3.04v8.38a12.1 12.1 0 0 0 3.75 0v-8.38h2.8z" />
  </svg>
)

export function Login({ onDone, initialMode = 'login', onBack, initialError = '', next, refToken = '' }:
  { onDone: (m: Me) => void; initialMode?: 'login' | 'signup'; onBack?: () => void; initialError?: string; next?: string; refToken?: string }) {
  const [mode, setMode] = useState<'login' | 'signup'>(initialMode)
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(initialError)
  const [busy, setBusy] = useState(false)
  const [prov, setProv] = useState<Providers | null>(null)
  useEffect(() => { api.authProviders().then(setProv) }, [])
  const social = prov && (prov.google || prov.facebook)

  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { onDone(await (mode === 'login' ? api.login(email, pw) : api.signup(email, pw, refToken))) }
    catch (ex) { setErr((ex as Error).message) }
    finally { setBusy(false) }
  }
  const verb = mode === 'login' ? '登入' : '註冊'
  return (
    <div className="auth">
      <aside className="auth-visual">
        <img className="logo" src={logo} alt="Lakeze 人客多" onClick={onBack} style={{ cursor: onBack ? 'pointer' : undefined }} />
        <div className="auth-copy">
          <h1><MiaoLogo size={64} tagline /></h1>
          <p>給素材和賣點，就能收到有旁白、配樂、雙層字幕的直式影片與封面。註冊送 110 點，夠做第一支。</p>
          <ol className="auth-steps">
            {STEPS.map(s => <li key={s.n}><span className="n">{s.n}</span><div><b>{s.t}</b><div className="muted small">{s.d}</div></div></li>)}
          </ol>
        </div>
        <div className="auth-foot muted small">人客多 Lakeze · 旅遊短影音自動剪片軟體</div>
      </aside>

      <main className="auth-panel">
        <form className="auth-card" onSubmit={go}>
          <div className="auth-logo-m"><MiaoLogo size={34} /></div>
          <h2>{mode === 'login' ? '歡迎回來' : '建立帳號'}</h2>
          <p className="muted">{mode === 'login' ? '登入後繼續你的專案。' : refToken ? '朋友分享的影片就是這樣做出來的。註冊送 110 點，第一支免費。' : '註冊就送 110 點，第一支影片含封面與 2 輪修改。'}</p>
          {social && (
            <>
              <div className="social">
                {prov.google && <a className="btn social-btn google" href={api.oauthStart('google', mode, next, refToken)}><GoogleIcon />用 Google {verb}</a>}
                {prov.facebook && <a className="btn social-btn facebook" href={api.oauthStart('facebook', mode, next, refToken)}><FacebookIcon />用 Facebook {verb}</a>}
              </div>
              <div className="or"><span>或用 Email</span></div>
            </>
          )}
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" autoFocus={!social} placeholder="you@example.com" />
          </label>
          <label className="field">
            <span>密碼</span>
            <input type="password" value={pw} onChange={e => setPw(e.target.value)} required minLength={8} placeholder={mode === 'signup' ? '至少 8 碼' : ''}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {err && <div className="error">{err}</div>}
          <button className="btn primary block lg" disabled={busy}>{busy ? '請稍候…' : mode === 'login' ? '登入' : '註冊並開始'}</button>
          <div className="auth-switch muted small">
            {mode === 'login' ? '還沒有帳號？' : '已經有帳號？'}
            <a onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setErr('') }}>{mode === 'login' ? '免費註冊' : '登入'}</a>
          </div>
          <div className="auth-legal muted small">繼續即表示你同意我們的服務條款與隱私權政策。</div>
          {onBack && <a className="small auth-back" onClick={onBack}>← 回首頁</a>}
        </form>
      </main>
    </div>
  )
}
