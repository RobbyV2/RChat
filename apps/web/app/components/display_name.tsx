'use client'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { useStoreApi } from '../lib/client/react'
import { useEffect, useId, useRef, useState, type HTMLAttributes } from 'react'
import { displayNameError } from '../lib/display_name'
import { isGuestName } from '../lib/guest_voice'
import { personName } from '../lib/names'
import { useStore } from '../lib/store'
import type { UserRef } from '../lib/types'
import { NameBody, useNameTitle } from './name'
import { FieldError, RevealScope, fieldCls } from './ui'

const nameFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

export const nameRevealKey = (username: string) => `name:${username}`

// A person's display name with their username after it, inside the caller's own element. `own`
// decides where the username is not an account here (P2P).
export function NameWithUsername({
  user,
  own,
  fit = false,
}: {
  user: Pick<UserRef, 'username' | 'display_name'>
  own?: boolean
  fit?: boolean
}) {
  const name = personName(user, 'shown', own)
  if (isGuestName(user.username)) return <span>{user.display_name}</span>
  return <NameBody of={name} fit={fit} />
}

type FitNameProps = { user: Pick<UserRef, 'username' | 'display_name'> } & Omit<
  HTMLAttributes<HTMLSpanElement>,
  'title' | 'children'
>

// A name in a row it fills (member list, message header). The span's title has the whole name
// as shown: masked until the pair is revealed, none in streamer mode.
export function FitName(props: FitNameProps) {
  return (
    <RevealScope>
      <FitNameSpan {...props} />
    </RevealScope>
  )
}

function FitNameSpan({ user, ...span }: FitNameProps) {
  const name = personName(user, 'shown')
  const title = useNameTitle(name)
  return (
    <span title={title} {...span}>
      <NameWithUsername user={user} fit />
    </span>
  )
}

export function DisplayNameField({ focus }: { focus: boolean }) {
  const store = useStoreApi()
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
    setText(store.getState().me?.display_name ?? '')
  }

  return (
    <Stack
      as="form"
      gap="sm"
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
    >
      <label htmlFor={id} className="text-sm text-on-surface-variant">
        Display name
      </label>
      <Row gap="sm" align="stretch">
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
        <Button
          type="submit"
          variant="filled"
          size="md"
          disabled={busy || text.trim() === saved}
          place="shrink-0"
        >
          Save
        </Button>
      </Row>
      <p id={`${id}-hint`} className="text-xs text-on-surface-variant">
        You still sign in and get mentioned as <span className="streamer">@{username}</span>.
      </p>
      <FieldError id={`${id}-error`} message={error} />
      {done && !error && <p className="text-xs text-on-surface-variant">Saved</p>}
    </Stack>
  )
}
