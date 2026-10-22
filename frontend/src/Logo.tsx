import { useId } from 'react'

/* 旅剪 TravelCut identity (CI "T3c"). One shape: a location pin (旅遊) with a play triangle inside (影片)
   and a dark clapper head cut across its top (剪接, 開拍) — three tiny white slate marks on the head.
   The playful rule: the pin and the "Cut" of the wordmark both lean 6° the same way; everything else
   (buttons, forms, body text, numbers) stays upright. Palette: orange #E95B17, ink #1F1B17, white. */

export const TILT = -6
const PIN = 'M32 5C19.3 5 9 14.9 9 27.2 9 44.6 32 61 32 61s23-16.4 23-33.8C55 14.9 44.7 5 32 5z'
const SCHEMES = {
  orange: { pin: '#E95B17', inner: '#FFFFFF', cap: '#1F1B17' },   // the default: on light and dark surfaces
  inv: { pin: '#FFFFFF', inner: '#E95B17', cap: '#1F1B17' },      // on an orange tile (app icon, primary buttons)
  mono: { pin: '#1F1B17', inner: '#FFFFFF', cap: '#6E675F' },     // one-colour print, favicons on dark
}
export type MarkScheme = keyof typeof SCHEMES

export function Mark({ size = 40, scheme = 'orange', tilt = TILT, clapper = true, className = '', label }:
  { size?: number; scheme?: MarkScheme; tilt?: number; clapper?: boolean; className?: string; label?: string }) {
  const id = useId().replace(/:/g, '')
  const c = SCHEMES[scheme]
  const ticks = [25.4, 30.9, 36.4].map(x => <path key={x} d={`M${x} 15.4l1.1-3.6h2.3l-1.1 3.6z`} fill={c.inner} />)
  const body = (
    <>
      <path d={PIN} fill={c.pin} />
      {clapper && (
        <>
          <defs><clipPath id={id}><path d={PIN} /></clipPath></defs>
          <g clipPath={`url(#${id})`}>
            <path d="M0 17.4 64 9.6V0H0z" fill={c.cap} />
            <g transform="rotate(-7 32 13.5)">{ticks}</g>
          </g>
        </>
      )}
      <path d="M26 21v18l15-9z" fill={c.inner} />
    </>
  )
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={`tc-mark ${className}`}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {tilt ? <g transform={`rotate(${tilt} 32 33)`}>{body}</g> : body}
    </svg>
  )
}

/* The wordmark. `both` (the default) is 旅剪 TravelCut: the Chinese name first in Noto Sans TC 900 ink,
   then Travel 600 ink and Cut 800 orange in Manrope, only the Cut leaning 6°. `en` and `zh` are the
   single-language cuts for tight spots. */
export function Wordmark({ lang = 'both', className = '' }: { lang?: 'both' | 'en' | 'zh'; className?: string }) {
  const en = <span className="tc-en"><span>Travel</span><span className="tc-cut" aria-hidden="true">Cut</span><span className="sr-only">Cut</span></span>
  if (lang === 'en') return <span className={`tc-word en ${className}`} aria-label="TravelCut">{en}</span>
  if (lang === 'zh') return <span className={`tc-word zh ${className}`} aria-label="旅剪"><span>旅</span><span className="tc-cut" aria-hidden="true">剪</span><span className="sr-only">剪</span></span>
  return <span className={`tc-word both ${className}`} aria-label="旅剪 TravelCut"><span className="tc-zh">旅剪</span>{en}</span>
}

/* Lockup: mark + wordmark, optionally a tagline line under it. `--mj` is the mark size; every other
   measure in the lockup is a ratio of it, so one number scales the whole thing. `light` is for dark
   surfaces (white text, soft-orange Cut). */
export function Logo({ size = 40, lang = 'both', tagline = false, className = '', light = false }:
  { size?: number; lang?: 'both' | 'en' | 'zh'; tagline?: boolean | string; className?: string; light?: boolean }) {
  const tag = tagline === true ? (lang === 'en' ? '旅剪 · 旅遊短影音自動剪片軟體' : lang === 'zh' ? 'TravelCut · 旅遊短影音自動剪片軟體' : '旅遊短影音自動剪片軟體') : tagline
  return (
    <span className={`tc-logo ${light ? 'light' : ''} ${className}`} style={{ ['--mj' as string]: `${size}px` }}>
      <Mark size={size} />
      <span className="tc-text">
        <Wordmark lang={lang} />
        {tag && <span className="tc-tag">{tag}</span>}
      </span>
    </span>
  )
}
