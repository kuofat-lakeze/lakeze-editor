import { useEffect, useRef, useState } from 'react'
import { MiaoMark } from './Logo'

/* Our own prompt / confirm / alert. The browser's built-in ones are headed with the bare domain
   ("editor.lakeze.com 顯示"), which looks like a scam; these carry the 人客多 旅剪 name instead.
   Usage: `const name = await ask.prompt('專案名稱')`, `if (!await ask.confirm('刪除？')) return`. */
type Req = {
  kind: 'prompt' | 'confirm' | 'alert'; message: string; placeholder?: string; value?: string
  examples?: (string | { label: string; kind?: string })[]   // tappable 例如 chips under the input (several kinds, so people see the range)
  ok?: string; danger?: boolean; resolve: (v: string | boolean | null) => void
}
let push: ((r: Req) => void) | null = null
const open = (r: Omit<Req, 'resolve'>) => new Promise<string | boolean | null>(resolve => {
  if (push) push({ ...r, resolve })
  else resolve(r.kind === 'prompt' ? window.prompt(r.message, r.value) : r.kind === 'confirm' ? window.confirm(r.message) : (window.alert(r.message), true))
})

export const ask = {
  prompt: (message: string, o: { placeholder?: string; value?: string; ok?: string; examples?: (string | { label: string; kind?: string })[] } = {}) =>
    open({ kind: 'prompt', message, ...o }) as Promise<string | null>,
  confirm: (message: string, o: { ok?: string; danger?: boolean } = {}) =>
    open({ kind: 'confirm', message, ...o }) as Promise<boolean>,
  alert: (message: string) => open({ kind: 'alert', message }) as Promise<boolean>,
}

export function DialogHost() {
  const [q, setQ] = useState<Req[]>([])
  const [val, setVal] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { push = r => setQ(x => [...x, r]); return () => { push = null } }, [])
  const cur = q[0]
  useEffect(() => { if (cur) { setVal(cur.value ?? ''); setTimeout(() => input.current?.focus(), 30) } }, [cur])
  if (!cur) return null
  const done = (v: string | boolean | null) => { cur.resolve(v); setQ(x => x.slice(1)) }
  const cancel = () => done(cur.kind === 'prompt' ? null : cur.kind === 'alert')
  const ok = () => done(cur.kind === 'prompt' ? val : true)
  return (
    <div className="dlg-scrim" onMouseDown={e => { if (e.target === e.currentTarget) cancel() }}
      onKeyDown={e => { if (e.key === 'Escape') cancel() }}>
      <div className="dlg" role="dialog" aria-modal="true">
        <div className="dlg-brand"><MiaoMark size={24} /><span>人客多 旅剪</span></div>
        <div className="dlg-msg">{cur.message}</div>
        {cur.kind === 'prompt' && (
          <input ref={input} className="dlg-in" value={val} placeholder={cur.placeholder} onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); ok() } }} />
        )}
        {cur.kind === 'prompt' && cur.examples && cur.examples.length > 0 && (
          <div className="dlg-ex"><span className="muted small">例如</span>{cur.examples.map(x => { const e = typeof x === 'string' ? { label: x } : x; return <a key={e.label} className={`chipbtn ${val === e.label ? 'on' : ''}`} onClick={() => { setVal(e.label); input.current?.focus() }}>{e.label}</a> })}</div>
        )}
        <div className="dlg-act">
          {cur.kind !== 'alert' && <button className="btn" onClick={cancel}>取消</button>}
          <button className={`btn ${cur.danger ? 'danger' : 'primary'}`} onClick={ok} autoFocus={cur.kind !== 'prompt'}>{cur.ok ?? (cur.kind === 'alert' ? '知道了' : '確定')}</button>
        </div>
      </div>
    </div>
  )
}
