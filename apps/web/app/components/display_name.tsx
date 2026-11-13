'use client'

import { useEffect, useId, useRef, useState, type HTMLAttributes } from 'react'
import { displayNameError, maskedName, showsUsername } from '../lib/display_name'
import { isGuestName } from '../lib/guest_voice'
import { useMask, useStore } from '../lib/store'
import type { UserRef } from '../lib/types'
import {
  FieldError,
  Masked,
  MaskedTogether,
  RevealScope,
  fieldCls,
  filledBtn,
  useOwn,
  useRevealed,
} from './ui'

const nameFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

export const nameRevealKey = (username: string) => `name:${username}`

// The display name truncates; the username stays whole after it. Both are masked for other
// people's names only: `own` decides where the username is not an account here (P2P). One reveal
// shows the whole pair. `fit`, for a narrow row that fills its width: the display name truncates
// down to a few letters, then the username wraps out of sight (the row's title has it).
export function NameWithUsername({
  user,
  own,
  fit = false,
}: {
  user: Pick<UserRef, 'username' | 'display_name'>
  own?: boolean
  fit?: boolean
}) {
  const by = own === undefined ? user.username : null
  if (isGuestName(user.username)) return <span>{user.display_name}</span>
  if (!showsUsername(user)) return <Masked text={user.display_name} by={by} own={own} />
  if (fit)
    return (
      <MaskedTogether word={nameRevealKey(user.username)}>
        <span className="flex h-[1lh] min-w-0 flex-wrap items-baseline overflow-hidden text-ellipsis">
          <span dir="auto" className="max-w-max min-w-0 flex-[1_1_4rem] truncate">
            <Masked text={user.display_name} by={by} own={own} />
          </span>
          <span className="streamer shrink-0 pl-1 text-on-surface-variant">
            (<Masked text={user.username} by={by} own={own} />)
          </span>
        </span>
      </MaskedTogether>
    )
  return (
    <MaskedTogether word={nameRevealKey(user.username)}>
      <span className="inline-flex max-w-full min-w-0 items-baseline">
        <span className="min-w-0 truncate">
          <Masked text={user.display_name} by={by} own={own} />
        </span>
        <span className="streamer max-w-full shrink-0 truncate pl-1 text-on-surface-variant">
          (<Masked text={user.username} by={by} own={own} />)
        </span>
      </span>
    </MaskedTogether>
  )
}

type FitNameProps = { user: Pick<UserRef, 'username' | 'display_name'> } & Omit<
  HTMLAttributes<HTMLSpanElement>,
  'title' | 'children'
>

// A name in a row it fills (member list, message header), as `fit`. The span's title has the
// whole name as shown: masked until the pair is revealed, none in streamer mode.
export function FitName(props: FitNameProps) {
  return (
    <RevealScope>
      <FitNameSpan {...props} />
    </RevealScope>
  )
}

function FitNameSpan({ user, ...span }: FitNameProps) {
  const own = useOwn(user.username)
  const revealed = useRevealed(nameRevealKey(user.username))
  const mask = useMask(own || revealed)
  const streamer = useStore(s => s.streamer)
  return (
    <span title={streamer ? undefined : maskedName(user, mask)} {...span}>
      <NameWithUsername user={user} fit />
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
