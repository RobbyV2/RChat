'use client'

import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { patchFor, shownValue, sourceOf } from '../../lib/admin_config'
import type { AdminRow } from '../../lib/admin_rows'
import { useApplyConfig, useControl } from './config_state'
import { Button, Pill } from '../controls'
import { Row, Surface } from '../layout'

// One line of the note: inset like the row above it, or `flush` with the box it sits in.
function Line({
  source,
  flush,
  children,
}: {
  source: string
  flush: boolean
  children: ReactNode
}) {
  const line = (
    <p data-source={source} className="text-xs text-on-surface-variant">
      <Row as="span" gap="sm" wrap>
        {children}
      </Row>
    </p>
  )
  if (flush) return line
  return (
    <Surface tone="plain" pad="sm" inset="bar">
      {line}
    </Surface>
  )
}

// Where a row's value comes from, under the row: pinned by the server config, the same as it,
// or different from it with a way to take the config's value.
export function SourceNote({ row, flush = false }: { row: AdminRow; flush?: boolean }) {
  const control = useControl(row.key)
  const apply = useApplyConfig()
  if (!control) return null
  const options = row.kind === 'choice' ? row.options : []
  switch (sourceOf(control)) {
    case 'none':
      return null
    case 'pinned':
      return (
        <Line source="pinned" flush={flush}>
          <Lock size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 break-words">
            Set in the server config (<code className="font-mono">{control.env}</code>)
          </span>
        </Line>
      )
    case 'same':
      return (
        <Line source="same" flush={flush}>
          <Pill tone="outline">From server config</Pill>
        </Line>
      )
    case 'differs': {
      const said = shownValue(control.config ?? '', options)
      return (
        <Line source="differs" flush={flush}>
          <span className="min-w-0 break-words">
            Server config says{' '}
            {row.kind === 'names' || row.kind === 'link' ? (
              <span className="streamer">{said}</span>
            ) : (
              said
            )}
            .
          </span>
          {patchFor(control.key, control.config ?? '') !== null && (
            <Button onClick={() => apply([control])} place="shrink-0">
              Use it
            </Button>
          )}
        </Line>
      )
    }
  }
}
