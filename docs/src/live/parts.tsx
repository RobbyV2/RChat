import type { ReactNode } from 'react'

// A name, blurred while streamer mode is on.
export const Name = ({ children }: { children: ReactNode }) => (
  <span className="streamer">{children}</span>
)

export const Title = ({ children }: { children: ReactNode }) => (
  <p className="text-base font-medium text-on-surface">{children}</p>
)

export const Note = ({ children, error = false }: { children: ReactNode; error?: boolean }) => (
  <p className={`text-sm ${error ? 'text-error' : 'text-on-surface-variant'}`}>{children}</p>
)
