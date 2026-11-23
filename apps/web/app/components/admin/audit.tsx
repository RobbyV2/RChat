'use client'
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
import { fieldCls, textBtn } from './touch'

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
    <div className="space-y-2">
      <Chips label="Kind" value={kind} options={AUDIT_KINDS} onChange={setKind} touch />
      <div className="flex">
        <input
          value={person}
          onChange={e => setPerson(e.target.value)}
          placeholder="Filter by person"
          aria-label="Filter by person"
          className={`${fieldCls} streamer`}
        />
      </div>
      <div className="space-y-1">
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
          <div
            key={e.id}
            className="flex flex-wrap items-baseline gap-x-2 rounded-xl bg-surface-container px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1 break-words">
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
          </div>
        ))}
        {next && auto && <Sentinel key={pages?.length ?? 0} onVisible={() => fetchFrom(next)} />}
        {next && !auto && (
          <button onClick={() => fetchFrom(next)} className={textBtn}>
            Load more
          </button>
        )}
      </div>
    </div>
  )
}
