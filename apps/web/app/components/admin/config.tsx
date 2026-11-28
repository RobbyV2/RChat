'use client'

import { Covered } from '../covered'
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
import { databaseRows } from '../../lib/database_rows'
import { adminRow } from '../../lib/admin_rows'
import { useStore } from '../../lib/store'
import type { ConfigControl } from '../../lib/types'
import { PageGroup, PageRow } from '../settings_page'
import { Chips } from '../ui'
import { useApplyConfig, useConfigStore } from './config_state'
import { Button, Pill } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'

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
  const names = NAMES.has(control.key)
  const where = row?.kind === 'link' ? 'servers' : 'features'
  return (
    <PageRow id={`config-${control.key}`} className="bg-surface-container">
      <Surface tone="plain" pad="md">
        <Row gap="md" wrap align="start">
          <div className="min-w-48 flex-1">
            <Stack gap="2xs">
              <Row gap="sm" wrap>
                <span className="min-w-0 text-sm break-words">{controlLabel(control)}</span>
                {source === 'pinned' && <Pill tone="outline">Pinned</Pill>}
                {source === 'differs' && <Pill tone="outline">Differs</Pill>}
              </Row>
              <code className="font-mono text-xs break-all text-on-surface-variant">
                {control.env}
              </code>
              <Grid as="dl" cols="pair" gap="md" lineGap="3xs" text="xs">
                <dt className="text-on-surface-variant">Value</dt>
                <Covered as="dd" what="value" on={names} look="break-words">
                  {shownValue(control.value, options)}
                </Covered>
                <dt className="text-on-surface-variant">Server config</dt>
                <Covered
                  as="dd"
                  what="value"
                  on={names && control.config !== null}
                  look="break-words"
                >
                  {control.config === null ? 'Not set' : shownValue(control.config, options)}
                </Covered>
              </Grid>
              {control.key === 'upload_expiry_max_days' && (
                <p className="text-xs text-on-surface-variant">{CAP_NOTE}</p>
              )}
            </Stack>
          </div>
          <Row gap="2xs" wrap justify="end">
            {source === 'differs' && patchFor(control.key, control.config ?? '') !== null && (
              <Button onClick={() => apply([control])}>Use server config</Button>
            )}
            {row && (
              <Button onClick={() => openAdmin(where, null, control.key)}>
                {where === 'servers' ? 'Show in Servers' : 'Show in Features'}
              </Button>
            )}
          </Row>
        </Row>
      </Surface>
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
    <Stack gap="lg">
      <Stack gap="md">
        <p className="text-sm text-on-surface-variant">
          Every setting has a name in the server config. A pinned one follows the config and
          can&apos;t be changed here. {summaryLine(config)}.
        </p>
        <Row gap="sm" wrap>
          <Chips label="Show" value={filter} options={CONFIG_FILTERS} onChange={setFilter} />
          <Button
            variant="filled"
            size="md"
            disabled={all.length === 0}
            onClick={() =>
              apply(
                all,
                `Set ${all.length === 1 ? '1 setting' : `${all.length} settings`} to what the server config says: ${all.map(controlLabel).join(', ')}.`
              )
            }
            place="ml-auto"
          >
            Use server config for all
          </Button>
        </Row>
      </Stack>
      <div>
        <PageGroup label="Settings">
          {shown.length === 0 && <p className="text-sm text-on-surface-variant">None.</p>}
          {shown.map(c => (
            <Control key={c.key} control={c} />
          ))}
        </PageGroup>
        {filter === 'all' && (
          <PageGroup label="Limits">
            <Stack gap="md">
              <p className="text-sm text-on-surface-variant">
                Limits are set in the server config. Restart to change.
              </p>
              <Stack gap="2xs">
                {config.limits.map(l => (
                  <PageRow key={l.env} id={`limit-${l.env}`} className="bg-surface-container">
                    <Surface tone="plain" pad="md" gap="3xs">
                      <Row gap="md" align="baseline">
                        <code className="min-w-0 flex-1 font-mono text-xs break-all">{l.env}</code>
                        <span className="text-sm">{limitValue(l)}</span>
                      </Row>
                      <span className="text-xs text-on-surface-variant">
                        {[
                          limitChanged(l) && l.default !== null ? `Default ${l.default}` : null,
                          l.range === '' ? null : `Range ${l.range}`,
                        ]
                          .filter(Boolean)
                          .join(', ') || 'Default'}
                      </span>
                    </Surface>
                  </PageRow>
                ))}
              </Stack>
            </Stack>
          </PageGroup>
        )}
        {filter === 'all' && config.database && (
          <PageGroup label="Database">
            <Stack gap="2xs">
              <p className="text-sm text-on-surface-variant">On this copy</p>
              <Surface tone="plain" pad="md" inset="bar">
                <Grid as="dl" cols="thirds" gap="md" lineGap="sm" text="sm">
                  {databaseRows(config.database).map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="break-words text-on-surface-variant">{label}</dt>
                      <dd className="break-words">{value}</dd>
                    </div>
                  ))}
                </Grid>
              </Surface>
            </Stack>
          </PageGroup>
        )}
      </div>
    </Stack>
  )
}
