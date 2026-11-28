'use client'
import { Name } from './name'
import { handleName } from '../lib/names'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { useStoreApi } from '../lib/client/react'
import { useEffect, useId, useRef, useState } from 'react'
import { displayNameError } from '../lib/display_name'
import { useStore } from '../lib/store'
import { FieldError, fieldCls } from './ui'

const nameFieldCls = fieldCls.replace(' border-outline', '').replace(' focus:border-primary', '')

export const nameRevealKey = (username: string) => `name:${username}`

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
        You still sign in and get mentioned as <Name of={handleName(username)} before="@" />.
      </p>
      <FieldError id={`${id}-error`} message={error} />
      {done && !error && <p className="text-xs text-on-surface-variant">Saved</p>}
    </Stack>
  )
}
