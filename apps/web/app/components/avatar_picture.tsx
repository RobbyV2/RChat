'use client'

import { useState, type ReactNode, type Ref } from 'react'

// A built-in avatar or server icon with the uploaded picture over it. The built-in one draws at
// once and keeps the box; the picture covers it when it has loaded, and one that fails is never
// shown. A `size` in pixels makes a round avatar; `fill` takes the box and the corners of what
// holds it (a server tile). `moving` is the picture's animation while it plays: it is loaded
// then, and covers the picture once it has, so the first frame shows until it does.
export function PictureOver({
  src,
  moving = null,
  boxRef,
  size,
  children,
}: {
  src: string | null
  moving?: string | null
  // The box, for whoever decides when the animation plays (`usePlays`).
  boxRef?: Ref<HTMLSpanElement>
  size: number | 'fill'
  children: ReactNode
}) {
  const [loaded, setLoaded] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [stuck, setStuck] = useState<string | null>(null)
  if (!src || failed === src) return <>{children}</>
  const side = size === 'fill' ? undefined : size
  const layer = 'absolute inset-0 h-full w-full rounded-inherit object-cover'
  return (
    <span
      ref={boxRef}
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
        width={side}
        height={side}
        draggable={false}
        decoding="async"
        onLoad={() => setLoaded(src)}
        onError={() => setFailed(src)}
        className={`${layer} bg-surface-container-highest ${loaded === src ? '' : 'opacity-0'}`}
      />
      {moving && stuck !== moving && (
        <img
          data-avatar-animation={playing === moving ? 'playing' : 'loading'}
          src={moving}
          alt=""
          width={side}
          height={side}
          draggable={false}
          onLoad={() => setPlaying(moving)}
          onError={() => setStuck(moving)}
          className={`${layer} ${playing === moving ? '' : 'opacity-0'}`}
        />
      )}
    </span>
  )
}
