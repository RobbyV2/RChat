'use client'

import { useState, type ReactNode } from 'react'

// A built-in avatar or server icon with the uploaded picture over it. The built-in one draws at
// once and keeps the box; the picture covers it when it has loaded, and one that fails is never
// shown. A `size` in pixels makes a round avatar; `fill` takes the box and the corners of what
// holds it (a server tile).
export function PictureOver({
  src,
  size,
  children,
}: {
  src: string | null
  size: number | 'fill'
  children: ReactNode
}) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <>{children}</>
  return (
    <span
      data-avatar-picture={loaded === src ? 'shown' : 'loading'}
      style={size === 'fill' ? undefined : { width: size, height: size }}
      className={
        size === 'fill'
          ? 'relative flex h-full w-full overflow-hidden rounded-inherit'
          : 'relative inline-flex shrink-0 overflow-hidden rounded-full'
      }
    >
      {children}
      <img
        src={src}
        alt=""
        width={size === 'fill' ? undefined : size}
        height={size === 'fill' ? undefined : size}
        draggable={false}
        decoding="async"
        onLoad={() => setLoaded(src)}
        onError={() => setFailed(src)}
        className={`absolute inset-0 h-full w-full rounded-inherit bg-surface-container-highest object-cover ${
          loaded === src ? '' : 'opacity-0'
        }`}
      />
    </span>
  )
}
