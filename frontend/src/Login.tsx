import { useState } from 'react'
import { api, type Me } from './api'

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
    <div className="center">
      <form className="card login" onSubmit={go}>
        <h1>Lakeze Editor</h1>
        <p className="muted">給素材和賣點，AI 剪輯師幫你做出有旁白的短影音和封面。</p>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="密碼（至少 8 碼）" value={pw} onChange={e => setPw(e.target.value)} required minLength={8} />
        {err && <div className="error">{err}</div>}
        <button className="btn primary block" disabled={busy}>{mode === 'login' ? '登入' : '註冊'}</button>
        <a className="small" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? '沒有帳號？註冊' : '已有帳號？登入'}
        </a>
      </form>
    </div>
  )
}
