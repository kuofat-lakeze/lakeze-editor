import { useState } from 'react'
import { api, type Me } from './api'
import logo from './assets/logo.png'

const STEPS = [
  { n: '1', t: '給素材', d: '貼 Google Drive 連結或上傳影片' },
  { n: '2', t: '選風格與聲音', d: '旅遊短影音、質感形象、促銷活動' },
  { n: '3', t: '收影片與封面', d: '剪輯師一路做到輸出，再分享給客戶' },
]

export function Login({ onDone }: { onDone: (m: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { onDone(await (mode === 'login' ? api.login(email, pw) : api.signup(email, pw))) }
    catch (ex) { setErr((ex as Error).message) }
    finally { setBusy(false) }
  }
  return (
    <div className="auth">
      <aside className="auth-visual">
        <img className="logo" src={logo} alt="Lakeze 人客多" />
        <div className="auth-copy">
          <h1>民宿的短影音，<br />交給 AI 剪輯師。</h1>
          <p>給素材和賣點，就能收到有旁白、配樂、雙層字幕的直式影片與封面。第一支免費。</p>
          <ol className="auth-steps">
            {STEPS.map(s => <li key={s.n}><span className="n">{s.n}</span><div><b>{s.t}</b><div className="muted small">{s.d}</div></div></li>)}
          </ol>
        </div>
        <div className="auth-foot muted small">人客多 · 專業旅遊剪輯 AI</div>
      </aside>

      <main className="auth-panel">
        <form className="auth-card" onSubmit={go}>
          <img className="logo auth-logo-m" src={logo} alt="Lakeze 人客多" />
          <h2>{mode === 'login' ? '歡迎回來' : '建立帳號'}</h2>
          <p className="muted">{mode === 'login' ? '登入後繼續你的專案。' : '第一個專案的第一版影片、封面與 4 輪修改免費。'}</p>
          <label className="field">
            <span>Email</span>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" autoFocus placeholder="you@example.com" />
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
        </form>
      </main>
    </div>
  )
}
