'use client'

import { useState } from 'react'
import {
  CONFIG_FILTERS,
  differing,
  filterControls,
  limitChanged,
  limitValue,
  patchFor,
  shownValue,
  sourceOf,
  summaryLine,
  type ConfigFilter,
} from '../../lib/admin_config'
import { adminRow } from '../../lib/admin_rows'
import { useStore } from '../../lib/store'
import type { ConfigControl } from '../../lib/types'
import { PageGroup, PageRow } from '../settings_page'
import { Chips } from '../ui'
import { useApplyConfig, useConfigStore } from './config_state'
import { chipCls } from './source'
import { filledBtn, textBtn } from './touch'

// Controls whose values are usernames or server names.
const NAMES = new Set(['server_creators', 'default_servers'])

export const controlLabel = (c: ConfigControl) => adminRow(c.key)?.label ?? c.key

export const CAP_NOTE =
  'A lower value in the server config removes files older than it at the next start.'

function Control({ control }: { control: ConfigControl }) {
  const openAdmin = useStore(s => s.openAdmin)
  const apply = useApplyConfig()
  const row = adminRow(control.key)
  const options = row?.kind === 'choice' ? row.options : []
  const source = sourceOf(control)
  const names = NAMES.has(control.key) ? 'streamer' : ''
  return (
    <PageRow
      id={`config-${control.key}`}
      className="flex flex-wrap items-start gap-x-3 gap-y-1 bg-surface-container px-3 py-2"
    >
      <div className="flex min-w-48 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-sm break-words">{controlLabel(control)}</span>
          {source === 'pinned' && <span className={chipCls}>Pinned</span>}
          {source === 'differs' && <span className={chipCls}>Differs</span>}
        </div>
        <code className="font-mono text-xs break-all text-on-surface-variant">{control.env}</code>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-on-surface-variant">Value</dt>
          <dd className={`break-words ${names}`}>{shownValue(control.value, options)}</dd>
          <dt className="text-on-surface-variant">Server config</dt>
          <dd className={`break-words ${control.config === null ? '' : names}`}>
            {control.config === null ? 'Not set' : shownValue(control.config, options)}
          </dd>
        </dl>
        {control.key === 'upload_expiry_max_days' && (
          <p className="text-xs text-on-surface-variant">{CAP_NOTE}</p>
        )}
      </div>
      <div className="-mx-2 flex flex-wrap gap-1 sm:mx-0 sm:flex-col sm:items-end">
        {source === 'differs' && patchFor(control.key, control.config ?? '') !== null && (
          <button onClick={() => apply([control])} className={textBtn}>
            Use server config
          </button>
        )}
        {row && (
          <button onClick={() => openAdmin('features', null, control.key)} className={textBtn}>
            Show in Features
          </button>
        )}
      </div>
    </PageRow>
  )
}

// Every control with its name in the server config, its value there and whether it is pinned,
// and the limits, which only the config sets.
export function ConfigSection() {
  const config = useConfigStore(s => s.config)
  const apply = useApplyConfig()
  const [filter, setFilter] = useState<ConfigFilter>('all')
  if (!config) return <p className="text-sm text-on-surface-variant">Loading</p>
  const all = differing(config)
  const shown = filterControls(config.controls, filter)
  return (
    <div>
      <p className="pb-3 text-sm text-on-surface-variant">
        Every setting has a name in the server config. A pinned one follows the config and
        can&apos;t be changed here. {summaryLine(config)}.
      </p>
      <div className="flex flex-wrap items-center gap-2 pb-4">
        <Chips label="Show" value={filter} options={CONFIG_FILTERS} onChange={setFilter} touch />
        <span className="flex-1" />
        <button
          disabled={all.length === 0}
          onClick={() =>
            apply(
              all,
              `Set ${all.length === 1 ? '1 setting' : `${all.length} settings`} to what the server config says: ${all.map(controlLabel).join(', ')}.`
            )
          }
          className={filledBtn}
        >
          Use server config for all
        </button>
      </div>
      <PageGroup label="Settings">
        {shown.length === 0 && <p className="text-sm text-on-surface-variant">None.</p>}
        {shown.map(c => (
          <Control key={c.key} control={c} />
        ))}
      </PageGroup>
      {filter === 'all' && (
        <PageGroup label="Limits">
          <p className="pb-2 text-sm text-on-surface-variant">
            Limits are set in the server config. Restart to change.
          </p>
          {config.limits.map(l => (
            <PageRow
              key={l.env}
              id={`limit-${l.env}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 bg-surface-container px-3 py-2"
            >
              <code className="min-w-0 flex-1 font-mono text-xs break-all">{l.env}</code>
              <span className="text-sm">{limitValue(l)}</span>
              <span className="w-full text-xs text-on-surface-variant">
                {[
                  limitChanged(l) && l.default !== null ? `Default ${l.default}` : null,
                  l.range === '' ? null : `Range ${l.range}`,
                ]
                  .filter(Boolean)
                  .join(', ') || 'Default'}
              </span>
            </PageRow>
          ))}
        </PageGroup>
      )}
    </div>
  )
}
