'use client'
import { useAccount, useConn } from '../../lib/client/react'
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../../lib/api'
import { errorText, useStore } from '../../lib/store'
import type { Announcement } from '../../lib/announcements'
import { PageGroup, PageRow } from '../settings_page'
import { dangerBtn, fieldCls, filledBtn } from './touch'

export function AnnouncementEditor() {
  const conn = useConn()
  const scope = useStore(s => JSON.stringify([conn.origin, s.me?.username]))
  return <Editor key={scope} />
}

function Editor() {
  const ownerSession = useAccount()
  const [rows, setRows] = useState<Announcement[]>([])
  const [message, setMessage] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [available, setAvailable] = useState(true)
  const [loadError, setLoadError] = useState('')
  const brand = useStore(s => s.brand)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let generation = 0
    const mark = ownerSession.lifetime.sessionMark()
    const load = async () => {
      const id = ++generation
      try {
        const next = await ownerSession.api.adminAnnouncements()
        if (id === generation && mark === ownerSession.lifetime.sessionMark()) {
          setRows(next)
          setLoadError('')
        }
      } catch (e) {
        if (id !== generation || mark !== ownerSession.lifetime.sessionMark()) return
        if (e instanceof ApiError && e.status === 404) setAvailable(false)
        else setLoadError(errorText(e))
      }
    }
    if (!available) return
    void load()
    window.addEventListener('rchat-announcements', load)
    window.addEventListener('online', load)
    const timer = setInterval(load, 30000)
    return () => {
      mounted.current = false
      ++generation
      window.removeEventListener('rchat-announcements', load)
      window.removeEventListener('online', load)
      clearInterval(timer)
    }
  }, [ownerSession, brand, available])
  async function save(id?: string) {
    if (busy) return
    const mark = ownerSession.lifetime.sessionMark()
    const current = () => mounted.current && mark === ownerSession.lifetime.sessionMark()
    setBusy(true)
    setError('')
    try {
      if (id) await ownerSession.api.removeAnnouncement(id)
      else {
        const starts_at = start ? new Date(start).getTime() / 1000 : 0
        const ends_at = new Date(end).getTime() / 1000
        if (!Number.isFinite(ends_at) || ends_at <= starts_at)
          throw new Error('Choose an end time after the start.')
        await ownerSession.api.scheduleAnnouncement({ message, starts_at, ends_at })
        if (current()) {
          setMessage('')
          setStart('')
          setEnd('')
        }
      }
      if (current()) window.dispatchEvent(new Event('rchat-announcements'))
    } catch (e) {
      if (current()) setError(errorText(e))
    } finally {
      if (current()) setBusy(false)
    }
  }
  return (
    <PageGroup label="Announcements">
      <PageRow id="announcements">
        {!available ? (
          <p>Announcements are unavailable on this server version.</p>
        ) : (
          <div className="flex flex-col gap-4">
            <form
              onSubmit={e => {
                e.preventDefault()
                void save()
              }}
              className="flex flex-col gap-3"
            >
              <label className="grid gap-1 text-sm font-medium">
                Announcement
                <input
                  required
                  maxLength={500}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  className={fieldCls}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1 text-sm">
                  Start (leave blank for now)
                  <input
                    type="datetime-local"
                    value={start}
                    onChange={e => setStart(e.target.value)}
                    className={fieldCls}
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-sm">
                  End
                  <input
                    type="datetime-local"
                    required
                    value={end}
                    onChange={e => setEnd(e.target.value)}
                    className={fieldCls}
                  />
                </label>
              </div>
              <p className="text-xs text-on-surface-variant">Dates use your local time.</p>
              <button disabled={busy} className={filledBtn + ' self-start'}>
                {start ? 'Schedule announcement' : 'Publish now'}
              </button>
            </form>
            {(error || loadError) && (
              <p role="alert" className="text-sm text-error">
                {error || loadError}
              </p>
            )}
            <h3 className="text-sm font-medium">Active and upcoming</h3>
            {!rows.length && <p className="text-sm text-on-surface-variant">No announcements.</p>}
            {rows.map(a => (
              <div
                key={a.id}
                className="flex min-w-0 flex-wrap items-center gap-2 border-t border-outline-variant pt-2"
              >
                <div className="min-w-0 grow basis-48">
                  <p className="break-words text-sm">{a.message}</p>
                  <p className="text-xs text-on-surface-variant">
                    {new Date(a.starts_at * 1000).toLocaleString()} to{' '}
                    {new Date(a.ends_at * 1000).toLocaleString()}
                  </p>
                </div>
                <button disabled={busy} className={dangerBtn} onClick={() => void save(a.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </PageRow>
    </PageGroup>
  )
}
