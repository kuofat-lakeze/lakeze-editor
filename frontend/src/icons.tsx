/* One line-icon set for the action buttons (24-unit grid, 2px round strokes — the style every polished
   mobile SaaS uses), so 聽／改字／唸法／拿掉／親自唸 look like one family instead of a mix of glyphs and emoji. */
const I = ({ d, size = 16, fill }: { d: string | string[]; size?: number; fill?: boolean }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {(Array.isArray(d) ? d : [d]).map((p, i) => <path key={i} d={p} />)}
  </svg>
)
export const IcPlay = ({ size }: { size?: number }) => <I size={size} fill d="M7 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 7 5.5z" />
export const IcStop = ({ size }: { size?: number }) => <I size={size} fill d="M6 6h12v12H6z" />
export const IcPencil = ({ size }: { size?: number }) => <I size={size} d={['M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'm15 5 4 4']} />
export const IcSpeech = ({ size }: { size?: number }) => <I size={size} d={['M3 12h2', 'M7 8v8', 'M11 5v14', 'M15 8v8', 'M19 11v2']} />   // audio lines: how it sounds
export const IcTrash = ({ size }: { size?: number }) => <I size={size} d={['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6', 'M10 11v6', 'M14 11v6']} />
export const IcMinus = ({ size }: { size?: number }) => <I size={size} d={['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M8 12h8']} />
export const IcMic = ({ size }: { size?: number }) => <I size={size} d={['M12 15a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5a4 4 0 0 0 4 4z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3', 'M8 21h8']} />
export const IcStar = ({ size }: { size?: number }) => <I size={size} d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z" />
export const IcUndo = ({ size }: { size?: number }) => <I size={size} d={['M3 7v6h6', 'M3.5 13A9 9 0 1 0 6 5.3L3 8']} />
export const IcClip = ({ size }: { size?: number }) => <I size={size} d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
export const IcKeyboard = ({ size }: { size?: number }) => <I size={size} d={['M3 6h18v12H3z', 'M7 10h.01', 'M11 10h.01', 'M15 10h.01', 'M7 14h10']} />
export const IcWifi = ({ size }: { size?: number }) => <I size={size} d={['M2 8.8a15 15 0 0 1 20 0', 'M5.5 12.3a10 10 0 0 1 13 0', 'M9 15.8a5 5 0 0 1 6 0', 'M12 19.5h.01']} />
export const IcTimer = ({ size }: { size?: number }) => <I size={size} d={['M10 2h4', 'M12 14l3-3', 'M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z']} />
export const IcCheck = ({ size }: { size?: number }) => <I size={size} d="m4 12.5 5 5L20 6.5" />
export const IcRedo = ({ size }: { size?: number }) => <I size={size} d={['M21 7v6h-6', 'M20.5 13A9 9 0 1 1 18 5.3L21 8']} />
export const IcRefresh = ({ size }: { size?: number }) => <I size={size} d={['M21 12a9 9 0 1 1-2.6-6.4L21 8', 'M21 3v5h-5']} />
