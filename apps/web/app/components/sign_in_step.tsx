'use client'
import { Button } from './controls'
import { Stack, Surface } from './layout'
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
import { showPasswordForm, showRegister } from '../lib/sso'
import { ProviderButtons } from './sso/provider_buttons'
import { AvatarPicker } from './avatar_picker'
import { PassSwitch, WordGrid } from './word_grid'
import { FieldError } from './ui'
import { time } from '../lib/platform/time'
type Mode = 'login' | 'register'
const inputBase = 'rounded-lg border bg-transparent px-3 py-2 outline-none'
const inputCls = `${inputBase} border-outline focus:border-primary`
export function SignInStep({
  owner = null,
  missing = false,
  selectAccount,
  onSuccess,
  adding = false,
  back = '/',
}: {
  owner?: RouteOwner | null
  missing?: boolean
  selectAccount?: (user: string | null, mode: Mode | 'guest') => AccountSession | null
  onSuccess: (account: AccountSession) => void
  back?: string
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
  const auth = useStore(s => s.instance?.auth)
  const passwordEnabled = showPasswordForm(
    auth,
    typeof window === 'undefined' ? '' : window.location.search
  )

  const guestsEnabled = useStore(s => s.settings.guests_enabled)

  const [picked, setMode] = useState<Mode>('login')
  const signup = useStore(s => passwordSignup(s.settings)) && showRegister(auth)
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
    const timer = time().after(300, () => {
      api
        .words(name)
        .then(res => {
          if (!live) return
          setWords(res.words)
          setSelected(sel => sel.filter(w => res.words.includes(w)))
        })
        .catch(e => live && setError(e instanceof Error ? e.message : String(e)))
    })
    return () => {
      live = false
      timer()
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
      className={`flex-1 rounded-full py-2 text-sm font-medium outline-offset-2 transition-colors focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-11 ${
        mode === value
          ? 'bg-primary-container text-on-primary-container'
          : 'text-on-surface-variant hover-idle:bg-on-surface/8'
      }`}
    >
      {label}
    </button>
  )

  return (
    <>
      {signup && !owner && (
        <Surface pad="2xs" gap="2xs" row tone="base" radius="full" align="stretch">
          {tab('login', 'Log in')}
          {tab('register', 'Create account')}
        </Surface>
      )}
      {!missing && auth && mode === 'login' && (!owner || owner.username !== null) && (
        <ProviderButtons
          account={account}
          providers={auth.providers}
          clientReturn={auth.client_return === true}
          back={back}
          username={owner?.username ?? null}
          divider={passwordEnabled}
          onSuccess={onSuccess}
        />
      )}
      {passwordEnabled && (!owner || owner.username !== null) && (
        <Stack as="form" gap="lg" onSubmit={submit}>
          <Stack gap="none">
            <Stack as="label" gap="2xs">
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
            </Stack>
            <FieldError id={nameId} message={nameError} />
          </Stack>
          <PassSwitch value={passKind} onChange={setPassKind} />
          {passKind === 'text' ? (
            <Stack as="label" gap="2xs">
              <span className="text-sm text-on-surface-variant">Password</span>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                className={inputCls}
              />
            </Stack>
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
            <Surface as="p" tone="error" radius="md" pad="md">
              <span className="text-sm">
                {adding && <span className="streamer">{account.conn.host}: </span>}
                {error}
              </span>
            </Surface>
          )}
          <Button type="submit" variant="filled" size="md" disabled={busy}>
            {mode === 'login' ? 'Log in' : 'Create account'}
          </Button>
        </Stack>
      )}
      {(!owner || owner.username === null) && guestsEnabled && !missing && (
        <Button
          size="md"
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
        >
          {adding ? 'Browse as a guest' : 'Continue as a guest'} <ArrowRight size={16} />
        </Button>
      )}
    </>
  )
}
