/* 旅剪 Tripcut identity. Three shapes: a location pin (旅遊) with a play triangle on it (影片), a clapper
   snapping down on its head (剪接), and the pin is mid-hop — a tilt and a little shadow (快速, and the
   fun). Nothing else (簡單). `tone="light"` is the white tile used in the app; `tone="brand"` is the
   orange tile for dark surfaces, avatars and app icons. */
export function MiaoMark({ size = 40, radius = 0.25, tone = 'light' }: { size?: number; radius?: number; tone?: 'light' | 'brand' }) {
  const r = 64 * radius
  const brand = tone === 'brand'
  const pin = brand ? '#FFFFFF' : 'url(#mj-og)'      // the pin
  const play = brand ? 'url(#mj-og)' : '#FFFFFF'     // the play triangle on it
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="旅剪 Tripcut" className="miao-mark">
      <defs>
        <linearGradient id="mj-og" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#EC5A1E" /><stop offset="1" stopColor="#F5921E" />
        </linearGradient>
      </defs>
      {brand
        ? <rect width="64" height="64" rx={r} fill="url(#mj-og)" />
        : <rect x=".5" y=".5" width="63" height="63" rx={r} fill="#FFFFFF" stroke="#E6E1D9" strokeWidth="1" />}
      {/* the hop: a little shadow the pin just left */}
      <ellipse cx="33.5" cy="56.5" rx="7" ry="1.7" fill={brand ? '#FFFFFF' : '#22262E'} opacity={brand ? .35 : .14} />
      <g transform="translate(33 34) scale(.9) rotate(-8) translate(-32 -34)">
        {/* the pin: where the trip is */}
        <path d="M32 11.5c-9.4 0-16 6.9-16 15.6 0 10.9 16 26.4 16 26.4s16-15.5 16-26.4c0-8.7-6.6-15.6-16-15.6z" fill={pin} />
        {/* press play */}
        <polygon points="27.5,20.5 39.5,27.3 27.5,34.1" fill={play} />
        {/* the clapper, snapping down on the pin's head */}
        <g transform="rotate(-14 17 18)">
          <rect x="15" y="10.5" width="33" height="8" rx="3" fill="#22262E" />
          <g fill="#FFFFFF"><polygon points="23,10.5 27.5,10.5 24.5,18.5 20,18.5" /><polygon points="34,10.5 38.5,10.5 35.5,18.5 31,18.5" /><polygon points="45,10.5 48,10.5 46,18.5 42,18.5" /></g>
        </g>
      </g>
    </svg>
  )
}

/* The English wordmark carries the mark's idea: the dot of the i is the location pin (the letters are
   Nunito 900 — round, friendly; the i is a dotless ı so the pin can sit where the dot would). */
export function TripcutWord({ className = '' }: { className?: string }) {
  return (
    <span className={`miao-en ${className}`} aria-label="Tripcut">
      <span>Tr</span>
      <span className="tc-i" aria-hidden="true">ı<svg viewBox="0 0 10 13" className="tc-pin"><path d="M5 .5C2.5.5.7 2.3.7 4.6c0 3 4.3 7.9 4.3 7.9s4.3-4.9 4.3-7.9C9.3 2.3 7.5.5 5 .5z" fill="currentColor" /><circle cx="5" cy="4.6" r="1.6" fill="#fff" /></svg></span>
      <span>pcut</span>
    </span>
  )
}

export function MiaoLogo({ size = 40, tagline = false, className = '', tone = 'light', en = true }:
  { size?: number; tagline?: boolean; className?: string; tone?: 'light' | 'brand'; en?: boolean }) {
  return (
    <span className={`miao-logo ${className}`} style={{ ['--mj' as string]: `${size}px` }}>
      <MiaoMark size={size} tone={tone} />
      <span className="miao-text">
        <span className="miao-word">旅剪{en && <TripcutWord />}</span>
        {tagline && <span className="miao-tag">旅遊短影音自動剪片軟體</span>}
      </span>
    </span>
  )
}
