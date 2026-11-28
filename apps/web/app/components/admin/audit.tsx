'use client'
import { NameInput } from '../name'
import { useAccount } from '../../lib/client/react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  AUDIT_KINDS,
  auditFiltered,
  auditMatches,
  autoLoads,
  instanceAuditLine,
  quietPages,
  type AuditKind,
} from '../../lib/instance_audit'
import { errorText, useStore } from '../../lib/store'
import type { InstanceAuditEntry } from '../../lib/types'
import { Chips, Sentinel } from '../ui'
import { Button } from '../controls'
import { Row, Stack, Surface } from '../layout'

// What the site admin and the server config changed, newest first. With a filter on, the list
// stops loading by itself after a few pages without a match.
export function AuditSection() {
  const ownerSession = useAccount()
  const setError = useStore(s => s.setError)
  const [pages, setPages] = useState<InstanceAuditEntry[][] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [kind, setKind] = useState<AuditKind>('all')
  const [person, setPerson] = useState('')
  const busy = useRef(false)
  const fetchFrom = useCallback(
    (cursor: string | null) => {
      if (busy.current) return
      busy.current = true
      ownerSession.api
        .adminAudit(cursor)
        .then(page => {
          setPages(cur => {
            const base = cursor === null ? [] : (cur ?? [])
            const seen = new Set(base.flat().map(e => e.id))
            return [...base, page.items.filter(e => !seen.has(e.id))]
          })
          setNext(page.next)
        })
        .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e))))
        .finally(() => {
          busy.current = false
        })
    },
    [ownerSession, setError]
  )
  useEffect(() => {
    fetchFrom(null)
  }, [fetchFrom])
  const list = pages?.flat() ?? null
  const shown = (list ?? []).filter(e => auditMatches(e, kind, person))
  const filtered = auditFiltered(kind, person)
  const auto = autoLoads(filtered, quietPages(pages ?? [], kind, person))
  return (
    <Stack gap="sm">
      <Chips label="Kind" value={kind} options={AUDIT_KINDS} onChange={setKind} />
      <Row gap="none">
        <NameInput
          value={person}
          onChange={e => setPerson(e.target.value)}
          placeholder="Filter by person"
          aria-label="Filter by person"
        />
      </Row>
      <Stack gap="2xs">
        {list !== null && shown.length === 0 && (next === null || !auto) && (
          <p className="text-sm text-on-surface-variant">
            {!filtered
              ? 'Nothing yet.'
              : next === null
                ? 'No matches.'
                : 'No matches in the latest entries.'}
          </p>
        )}
        {shown.map(e => (
          <Surface key={e.id} tone="base" radius="lg" pad="md">
            <Row gap="sm" wrap align="baseline">
              <span className="min-w-0 flex-1 text-sm break-words">
                {instanceAuditLine(e).map((p, i) =>
                  p.name ? (
                    <span key={i} className="streamer">
                      {p.text}
                    </span>
                  ) : (
                    <Fragment key={i}>{p.text}</Fragment>
                  )
                )}
              </span>
              <time
                dateTime={new Date(e.at * 1000).toISOString()}
                className="shrink-0 text-xs text-on-surface-variant"
              >
                {new Date(e.at * 1000).toLocaleString()}
              </time>
            </Row>
          </Surface>
        ))}
        {next && auto && <Sentinel key={pages?.length ?? 0} onVisible={() => fetchFrom(next)} />}
        {next && !auto && (
          <Button onClick={() => fetchFrom(next)} place="self-start">
            Load more
          </Button>
        )}
      </Stack>
    </Stack>
  )
}
