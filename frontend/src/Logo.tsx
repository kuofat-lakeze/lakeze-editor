/* 秒剪 identity: a play triangle split by a cut (剪 + 影片) with three speed strokes (秒). */
export function MiaoMark({ size = 40, radius = 0.26 }: { size?: number; radius?: number }) {
  const r = 64 * radius
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="秒剪" className="miao-mark">
      <defs>
        <linearGradient id="mj-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#EC5A1E" /><stop offset="1" stopColor="#F5921E" />
        </linearGradient>
        <clipPath id="mj-upper"><polygon points="0,0 64,0 64,64" transform="translate(2,-2) rotate(0)" /></clipPath>
      </defs>
      <rect width="64" height="64" rx={r} fill="url(#mj-bg)" />
      {/* speed strokes */}
      <g stroke="#FFFFFF" strokeWidth="3.2" strokeLinecap="round" opacity=".9">
        <line x1="9" y1="24" x2="18" y2="24" />
        <line x1="12" y1="32" x2="18" y2="32" />
        <line x1="9" y1="40" x2="18" y2="40" />
      </g>
      {/* play triangle, cut in two along a diagonal; the lower half slips down-right */}
      <g>
        <polygon points="26,17 51,32 26,47" fill="#FFFFFF" clipPath="url(#mj-cut-a)" />
        <clipPath id="mj-cut-a"><polygon points="0,0 64,0 64,64 60,64 20,22 20,0" /></clipPath>
        <clipPath id="mj-cut-b"><polygon points="0,0 16,0 60,46 64,64 0,64" /></clipPath>
        <polygon points="26,17 51,32 26,47" fill="#FFFFFF" clipPath="url(#mj-cut-b)" transform="translate(2.6,2.6)" />
      </g>
      {/* the blade line */}
      <line x1="20" y1="18" x2="52" y2="52" stroke="#46B9BD" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="53.5" cy="53.5" r="3.2" fill="#1B7AC3" stroke="#FFFFFF" strokeWidth="1.6" />
    </svg>
  )
}

export function MiaoLogo({ size = 40, tagline = false, className = '' }: { size?: number; tagline?: boolean; className?: string }) {
  return (
    <span className={`miao-logo ${className}`} style={{ ['--mj' as string]: `${size}px` }}>
      <MiaoMark size={size} />
      <span className="miao-text">
        <span className="miao-word">秒剪</span>
        {tagline && <span className="miao-tag">旅遊短影音自動剪片軟體</span>}
      </span>
    </span>
  )
}
