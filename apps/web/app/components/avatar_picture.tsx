'use client'

import { useState, type ReactNode } from 'react'

// A built-in avatar with the uploaded picture over it. The built-in one draws at once and keeps
// the box; the picture covers it when it has loaded, and one that fails is never shown.
export function PictureOver({
  src,
  size,
  children,
}: {
  src: string | null
  size: number
  children: ReactNode
}) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <>{children}</>
  return (
    <span
      data-avatar-picture={loaded === src ? 'shown' : 'loading'}
      style={{ width: size, height: size }}
      className="relative inline-flex shrink-0 overflow-hidden rounded-full"
    >
      {children}
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        draggable={false}
        decoding="async"
        onLoad={() => setLoaded(src)}
        onError={() => setFailed(src)}
        className={`absolute inset-0 h-full w-full rounded-full bg-surface-container-highest object-cover ${
          loaded === src ? '' : 'opacity-0'
        }`}
      />
    </span>
  )
}
