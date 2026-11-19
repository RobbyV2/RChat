'use client'

import { Lock } from 'lucide-react'
import { patchFor, shownValue, sourceOf } from '../../lib/admin_config'
import type { AdminRow } from '../../lib/admin_rows'
import { useApplyConfig, useControl } from './config_state'
import { textBtn } from './touch'

const lineCls =
  'flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pb-1 text-xs text-on-surface-variant'

export const chipCls =
  'rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant'

// Where a row's value comes from, under the row: pinned by the server config, the same as it,
// or different from it with a way to take the config's value.
export function SourceNote({ row }: { row: AdminRow }) {
  const control = useControl(row.key)
  const apply = useApplyConfig()
  if (!control) return null
  const options = row.kind === 'choice' ? row.options : []
  switch (sourceOf(control)) {
    case 'none':
      return null
    case 'pinned':
      return (
        <p data-source="pinned" className={lineCls}>
          <Lock size={14} aria-hidden className="shrink-0" />
          <span className="min-w-0 break-words">
            Set in the server config (<code className="font-mono">{control.env}</code>)
          </span>
        </p>
      )
    case 'same':
      return (
        <p data-source="same" className={lineCls}>
          <span className={chipCls}>From server config</span>
        </p>
      )
    case 'differs':
      return (
        <p data-source="differs" className={lineCls}>
          <span className="min-w-0 break-words">
            Server config says {shownValue(control.config ?? '', options)}.
          </span>
          {patchFor(control.key, control.config ?? '') !== null && (
            <button onClick={() => apply([control])} className={`${textBtn} -my-1 shrink-0`}>
              Use it
            </button>
          )}
        </p>
      )
  }
}
