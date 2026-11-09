'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { displayNameError, showsUsername } from '../lib/display_name'
import { useStore } from '../lib/store'
import type { UserRef } from '../lib/types'
import { FieldError, Masked, fieldCls, filledBtn } from './ui'

const nameFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

// The display name truncates; the username stays whole after it. Both are masked for other
// people's names only: `own` decides where the username is not an account here (P2P).
export function NameWithUsername({
  user,
  own,
}: {
  user: Pick<UserRef, 'username' | 'display_name'>
  own?: boolean
}) {
  const by = own === undefined ? user.username : null
  if (!showsUsername(user)) return <Masked text={user.display_name} by={by} own={own} />
  return (
    <span className="inline-flex max-w-full min-w-0 items-baseline">
      <span className="min-w-0 truncate">
        <Masked text={user.display_name} by={by} own={own} />
      </span>
      <span className="streamer max-w-full shrink-0 truncate pl-1 text-on-surface-variant">
        (<Masked text={user.username} by={by} own={own} />)
      </span>
    </span>
  )
}

export function DisplayNameField({ focus }: { focus: boolean }) {
  const saved = useStore(s => s.me?.display_name ?? '')
  const username = useStore(s => s.me?.username ?? '')
  const setDisplayName = useStore(s => s.setDisplayName)
  const [text, setText] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    setSeen(saved)
    if (text === seen) setText(saved)
  }
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  const id = useId()

  useEffect(() => {
    const el = ref.current
    if (!focus || !el) return
    el.scrollIntoView({ block: 'center' })
    el.focus({ preventScroll: true })
    el.select()
  }, [focus])

  const save = async () => {
    const invalid = displayNameError(text)
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy(true)
    const err = await setDisplayName(text)
    setBusy(false)
    setError(err)
    if (err) return
    setDone(true)
    setText(useStore.getState().me?.display_name ?? '')
  }

  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
      className="flex flex-col gap-2"
    >
      <label htmlFor={id} className="text-sm text-on-surface-variant">
        Display name
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          ref={ref}
          value={text}
          onChange={e => {
            setText(e.target.value)
            setError(null)
            setDone(false)
          }}
          autoComplete="nickname"
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          className={`${nameFieldCls} streamer min-w-0 flex-1 ${
            error !== null ? 'border-error' : 'border-outline focus:border-primary'
          }`}
        />
        <button
          type="submit"
          disabled={busy || text.trim() === saved}
          className={`${filledBtn} shrink-0`}
        >
          Save
        </button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-on-surface-variant">
        You still sign in and get mentioned as <span className="streamer">@{username}</span>.
      </p>
      <FieldError id={`${id}-error`} message={error} />
      {done && !error && <p className="text-xs text-on-surface-variant">Saved</p>}
    </form>
  )
}
