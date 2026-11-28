'use client'

import type { ReactNode } from 'react'
import { Dock, Row, Surface } from './layout'

// A note in a composer's place: why nothing can be sent here, or what is in the way.
export function GateNote({
  children,
  ...rest
}: {
  children: ReactNode
  role?: 'status'
  [data: `data-${string}`]: string | boolean | undefined
}) {
  return (
    <Dock gap="sm">
      <Surface {...rest} pad="lg" tone="base">
        <Row gap="sm" wrap text="sm" ink="muted">
          {children}
        </Row>
      </Surface>
    </Dock>
  )
}
