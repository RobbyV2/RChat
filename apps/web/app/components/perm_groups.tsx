'use client'

import { SwitchRow } from './controls'
import { useState } from 'react'
import { groupItems, matchItems, type PermItem } from '../lib/perm_source'
import { hasBit, maskXor } from '../lib/perms'
import { Stack } from './layout'
import { fieldCls } from './ui'

// A role's or @everyone's permissions in groups, with a search: one switch each. `blockOf(next)`
// says why the permissions may not become `next` (one switch turned), or null.
export function PermGroups({
  items,
  value,
  onChange,
  blockOf,
  locked,
}: {
  items: PermItem[]
  value: number
  onChange: (next: number) => void
  blockOf?: (next: number) => string | null
  locked?: string | null
}) {
  const [q, setQ] = useState('')
  const groups = groupItems(matchItems(items, q))
  return (
    <Stack data-perm-groups gap="sm">
      {items.length > 8 && (
        <input
          type="search"
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search permissions"
          aria-label="Search permissions"
          className={`${fieldCls} w-full`}
        />
      )}
      {groups.map(g => (
        <Stack key={g.group} gap="3xs">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            {g.group}
          </p>
          {g.items.map(item => {
            const on = hasBit(value, item.bit)
            const next = maskXor(value, item.bit)
            const block = locked ?? blockOf?.(next) ?? null
            return (
              <SwitchRow
                key={item.name}
                checked={on}
                label={item.label}
                hint={item.hint}
                title={block ?? item.hint ?? item.label}
                disabled={!!block}
                data-perm={item.name}
                onClick={() => onChange(next)}
              />
            )
          })}
        </Stack>
      ))}
      {groups.length === 0 && (
        <p className="text-xs text-on-surface-variant">No matching permissions.</p>
      )}
    </Stack>
  )
}
