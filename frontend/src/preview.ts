import { useEffect, useRef, useState, type RefObject } from 'react'
import { api } from './api'

/* 改完馬上聽: a narration change can be heard right away, before 套用, by playing the new audio (a freshly
   generated line, or the owner's own take) over the current video with its sound muted — the picture is
   the old cut, the voice is the new one. The same text is generated once and reused (試聽 in 唸錯了, then
   the preview over the picture, costs one sample, not two). Anything that changes the cut itself — order,
   lengths, styles — only shows after 套用 re-renders; the editors say so next to the button. */
const said = new Map<string, string>()
export async function sayCached(projectId: string, text: string, voiceId: string): Promise<{ url: string; cached: boolean }> {
  const k = `${projectId}|${voiceId}|${text.trim()}`
  const hit = said.get(k)
  if (hit) return { url: hit, cached: true }
  const r = await api.say(projectId, text.trim(), voiceId)
  said.set(k, r.url)
  return { url: r.url, cached: false }
}

export function useLinePreview(video: RefObject<HTMLVideoElement | null>) {
  const [on, setOn] = useState<string | null>(null)   // key of the line being previewed
  const audio = useRef<HTMLAudioElement | null>(null)
  const timer = useRef<number | null>(null)
  const gen = useRef(0)
  // iOS only lets media start inside a tap: the one audio element is touched during the tap and reused after the await
  const unlock = () => { if (!audio.current) { const a = new Audio(); a.preload = 'auto'; audio.current = a; a.play().catch(() => {}); a.pause() } }
  const stop = () => {
    gen.current++
    const a = audio.current; if (a) { a.pause(); a.onended = null; a.onerror = null }
    const v = video.current; if (v) { v.pause(); v.muted = false }
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setOn(null)
  }
  /** Play `url` while the video shows [start, end) without its own sound. Resolves when the preview ends. */
  const play = (key: string, start: number, end: number, url: string) => new Promise<void>(resolve => {
    stop(); unlock()
    const my = ++gen.current
    const a = audio.current!
    const finish = () => { if (gen.current === my) stop(); resolve() }
    a.onended = () => { const v = video.current; const rest = v ? Math.max(0, end - v.currentTime) : 0; timer.current = window.setTimeout(finish, Math.min(700, rest * 1000)) }
    a.onerror = finish
    a.src = url
    setOn(key)
    const v = video.current
    if (v) { v.muted = true; v.currentTime = start; v.play().catch(() => {}) }
    a.play().catch(finish)
  })
  useEffect(() => () => stop(), []) // eslint-disable-line react-hooks/exhaustive-deps
  return { on, play, stop, unlock }
}
