'use client'
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { useAccount, useStore } from '../lib/client/react'
import { restoreStreamer } from '../lib/start'
import { passwordSignup } from '../lib/features'
import { NAME_MAX, charCount } from '../lib/rules'
import type { RouteOwner } from '../lib/view'
import type { AvatarKind } from '../lib/types'
import type { AccountSession } from '../lib/client/session'
import type { PassKind } from '../lib/password'
import { AvatarPicker } from './avatar_picker'
import { PassSwitch, WordGrid } from './word_grid'
import { FieldError } from './ui'
type Mode = 'login' | 'register'
const inputBase = 'rounded-lg border bg-transparent px-3 py-2 outline-none'
const inputCls = `${inputBase} border-outline focus:border-primary`
export function SignInStep({
  owner = null,
  missing = false,
  selectAccount,
  onSuccess,
  adding = false,
}: {
  owner?: RouteOwner | null
  missing?: boolean
  selectAccount?: (user: string | null, mode: Mode | 'guest') => AccountSession | null
  onSuccess: (account: AccountSession) => void
  adding?: boolean
}) {
  const account = useAccount()
  const { api } = account
  const host = useStore(s => s.instanceHost)
  const error = useStore(s => s.error)
  const setError = useStore(s => s.setError)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const passwordEnabled = useStore(s => s.settings.password_login)
  const guestsEnabled = useStore(s => s.settings.guests_enabled)

  const [picked, setMode] = useState<Mode>('login')
  const signup = useStore(s => passwordSignup(s.settings))
  const mode: Mode = signup ? picked : 'login'
  const [username, setUsername] = useState(owner?.username ?? '')
  const [passKind, setPassKind] = useState<PassKind>('text')
  const [password, setPassword] = useState('')
  const [words, setWords] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [avatarKind, setAvatarKind] = useState<AvatarKind>('identicon')
  const [avatarColor, setAvatarColor] = useState('#6750a4')
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const nameId = useId()

  useEffect(() => {
    restoreStreamer(account)
    if (!owner && new URLSearchParams(window.location.search).get('mode') === 'register')
      setMode('register')
  }, [account, owner])

  useEffect(() => {
    if (passKind !== 'words') return
    const name = username.trim()
    if (!name) {
      setWords([])
      setSelected([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      api
        .words(name)
        .then(res => {
          if (!live) return
          setWords(res.words)
          setSelected(sel => sel.filter(w => res.words.includes(w)))
        })
        .catch(e => live && setError(e instanceof Error ? e.message : String(e)))
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, host, username, passKind, setError])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (missing) {
      setError('Connect to an RChat instance first')
      return
    }
    setError(null)
    setNameError(null)
    const name = username.trim()
    if (owner && owner.username !== name.toLowerCase()) return
    if (!name) {
      setNameError('Enter a username')
      return
    }
    if (mode === 'register' && charCount(name) > NAME_MAX) {
      setNameError(`Usernames can be at most ${NAME_MAX} characters`)
      return
    }
    if (mode === 'register' && name.includes('@')) {
      setNameError("Usernames can't contain @")
      return
    }
    if (passKind === 'words' && selected.length !== 7) {
      setError('Pick 7 words in order')
      return
    }
    if (mode === 'register' && passKind === 'text' && !password) {
      setError('Enter a password')
      return
    }
    const target = selectAccount ? selectAccount(name.toLowerCase(), mode) : account
    if (!target) return
    const { login, register } = target.store.getState()
    setBusy(true)
    const cred = passKind === 'text' ? { password } : { words: selected }
    if (mode === 'login') {
      await login({ username: name, ...cred })
    } else {
      const failed = await register({
        username: name,
        ...cred,
        avatar_kind: avatarKind,
        ...(avatarKind === 'color' ? { avatar_color: avatarColor } : {}),
      })
      if (failed?.field === 'username') setNameError(failed.message)
      else if (failed) setError(failed.message)
    }
    if (!mounted.current) return
    setBusy(false)
    const state = target.store.getState()
    if (state.me) onSuccess(target)
    else if (target !== account && state.error) setError(state.error)
  }

  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setMode(value)
        setError(null)
        setNameError(null)
      }}
      className={`flex-1 rounded-full py-2 text-sm font-medium transition-colors ${
        mode === value
          ? 'bg-primary-container text-on-primary-container'
          : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {label}
    </button>
  )

  return (
    <>
      {signup && !owner && (
        <div className="flex gap-1 rounded-full bg-surface-container p-1">
          {tab('login', 'Log in')}
          {tab('register', 'Create account')}
        </div>
      )}
      {passwordEnabled && (!owner || owner.username !== null) && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col">
            <label className="flex flex-col gap-1">
              <span className="text-sm text-on-surface-variant">Username</span>
              <input
                readOnly={!!owner}
                value={username}
                onChange={e => {
                  setUsername(e.target.value)
                  setNameError(null)
                }}
                autoFocus
                autoComplete="username"
                aria-invalid={nameError !== null}
                aria-describedby={nameError ? nameId : undefined}
                className={nameError ? `${inputBase} border-error` : inputCls}
              />
            </label>
            <FieldError id={nameId} message={nameError} />
          </div>
          <PassSwitch value={passKind} onChange={setPassKind} />
          {passKind === 'text' ? (
            <label className="flex flex-col gap-1">
              <span className="text-sm text-on-surface-variant">Password</span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className={inputCls}
              />
            </label>
          ) : words.length ? (
            <WordGrid words={words} selected={selected} onChange={setSelected} />
          ) : (
            <p className="text-sm text-on-surface-variant">
              Type a username to see its 20 words, then pick 7 in order.
            </p>
          )}
          {mode === 'register' && (
            <AvatarPicker
              username={username}
              kind={avatarKind}
              color={avatarColor}
              onKind={setAvatarKind}
              onColor={setAvatarColor}
            />
          )}
          {error && (
            <p className="rounded-lg bg-error-container px-3 py-2 text-sm text-on-error-container">
              {adding && <span className="streamer">{account.conn.host}: </span>}
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy}
            className="rounded-full bg-primary py-2.5 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      )}
      {(!owner || owner.username === null) && guestsEnabled && !missing && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            const target = selectAccount ? selectAccount(null, 'guest') : account
            if (!target) return
            setBusy(true)
            await target.store.getState().enterGuest()
            if (!mounted.current) return
            setBusy(false)
            if (target.store.getState().guest) onSuccess(target)
          }}
          className="flex flex-wrap items-center justify-center gap-x-1 rounded-full px-3 py-2 text-sm text-primary hover:bg-surface-container-high"
        >
          {adding ? 'Browse as a guest' : 'Continue as a guest'} <ArrowRight size={16} />
        </button>
      )}
    </>
  )
}
