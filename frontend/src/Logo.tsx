/* 秒剪 identity: a clapperboard snapping shut, leaning forward with speed streaks behind it,
   a play triangle on the board (剪 + 影片 + 秒). `tone="light"` is the white tile used in the app;
   `tone="brand"` is the orange tile for dark surfaces, avatars and app icons. */
export function MiaoMark({ size = 40, radius = 0.25, tone = 'light' }: { size?: number; radius?: number; tone?: 'light' | 'brand' }) {
  const r = 64 * radius
  const brand = tone === 'brand'
  const trailId = brand ? 'mj-trail-w' : 'mj-trail-o'
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="秒剪" className="miao-mark">
      <defs>
        <linearGradient id="mj-og" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#EC5A1E" /><stop offset="1" stopColor="#F5921E" />
        </linearGradient>
        <linearGradient id="mj-trail-o" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#F5921E" stopOpacity="0" /><stop offset="1" stopColor="#EC5A1E" />
        </linearGradient>
        <linearGradient id="mj-trail-w" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" /><stop offset="1" stopColor="#FFFFFF" stopOpacity=".85" />
        </linearGradient>
      </defs>
      {brand
        ? <rect width="64" height="64" rx={r} fill="url(#mj-og)" />
        : <rect x=".5" y=".5" width="63" height="63" rx={r} fill="#FFFFFF" stroke="#E6E1D9" strokeWidth="1" />}
      {/* speed streaks trailing behind the board */}
      <g stroke={`url(#${trailId})`} strokeWidth="3.2" strokeLinecap="round">
        <line x1="4" y1="33" x2="18" y2="33" /><line x1="8" y1="41" x2="19" y2="41" /><line x1="5" y1="49" x2="17" y2="49" />
      </g>
      {/* the clapperboard, leaning forward */}
      <g transform="skewX(-10) translate(7 0)">
        <g transform="rotate(-16 16 25)">
          <rect x="14" y="16" width="38" height="10.5" rx="2.5" fill="#22262E" />
          <g fill="#FFFFFF">
            <polygon points="20,16 25,16 21,26.5 16,26.5" /><polygon points="32,16 37,16 33,26.5 28,26.5" /><polygon points="44,16 49,16 45,26.5 40,26.5" />
          </g>
        </g>
        <rect x="14" y="27" width="38" height="25" rx="3" fill={brand ? '#FFFFFF' : 'url(#mj-og)'} />
        <polygon points="29,33 41,39.5 29,46" fill={brand ? 'url(#mj-og)' : '#FFFFFF'} />
      </g>
      {/* the snap */}
      <g stroke={brand ? '#FFFFFF' : '#46B9BD'} strokeWidth="2.4" strokeLinecap="round">
        <line x1="55" y1="11" x2="59" y2="7" /><line x1="57.5" y1="18" x2="62" y2="17" /><line x1="50" y1="8" x2="51" y2="3.5" />
      </g>
    </svg>
  )
}

export function MiaoLogo({ size = 40, tagline = false, className = '', tone = 'light' }: { size?: number; tagline?: boolean; className?: string; tone?: 'light' | 'brand' }) {
  return (
    <span className={`miao-logo ${className}`} style={{ ['--mj' as string]: `${size}px` }}>
      <MiaoMark size={size} tone={tone} />
      <span className="miao-text">
        <span className="miao-word">秒剪</span>
        {tagline && <span className="miao-tag">旅遊短影音自動剪片軟體</span>}
      </span>
    </span>
  )
}
