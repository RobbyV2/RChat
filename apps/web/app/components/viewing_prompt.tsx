'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { AccountProvider, useAccount, useLiveSessions } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'
import { filledBtn, textBtn, Masked } from './ui'

export function ViewingPrompt() {
  const sessions = useLiveSessions()
  return sessions.map(owner => (
    <AccountProvider key={owner.renderKey} session={owner}>
      <AccountPrompt />
    </AccountProvider>
  ))
}

function AccountPrompt() {
  const { useViewing, syncViewingStorage } = useAccount().viewing
  const prompt = useViewing(s => s.prompt)
  useEffect(() => {
    window.addEventListener('storage', syncViewingStorage)
    return () => window.removeEventListener('storage', syncViewingStorage)
  }, [syncViewingStorage])
  return prompt ? <Warning key={prompt.target.key} prompt={prompt} /> : null
}

function Warning({
  prompt,
}: {
  prompt: NonNullable<ReturnType<AccountSession['viewing']['useViewing']['getState']>['prompt']>
}) {
  const title = useId()
  const description = useId()
  const ref = useRef<HTMLDialogElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const [remember, setRemember] = useState(false)
  const app = prompt.target.kind === 'app'
  useEffect(() => {
    const el = ref.current!
    const opener = document.activeElement
    el.showModal()
    back.current?.focus()
    return () => {
      el.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={title}
      aria-describedby={description}
      onCancel={e => {
        e.preventDefault()
        prompt.answer(false, false)
      }}
      onKeyDown={e => e.stopPropagation()}
      className="fixed inset-0 m-auto max-h-[85dvh] w-[min(24rem,calc(100%-2rem))] max-w-full overflow-y-auto rounded-3xl bg-surface-container-high p-6 text-on-surface shadow-elevation-3 backdrop:bg-scrim/60"
    >
      <h2 id={title} className="text-lg font-medium">
        {app ? 'Open this app?' : 'Open sensitive channel?'}
      </h2>
      <p id={description} className="my-3 text-sm text-on-surface-variant">
        {app
          ? 'This app shows content and forms created by its author. Open it if you trust the source.'
          : 'This channel is marked sensitive. Open it to view its content.'}
      </p>
      <p className="break-words font-medium">
        <Masked text={prompt.target.name} />
      </p>
      <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="cursor-pointer"
          checked={remember}
          onChange={e => setRemember(e.target.checked)}
        />{' '}
        Remember on this device
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={back}
          className={textBtn + ' min-h-11 cursor-pointer'}
          onClick={() => prompt.answer(false, false)}
        >
          Cancel
        </button>
        <button
          className={filledBtn + ' min-h-11 cursor-pointer'}
          onClick={() => prompt.answer(true, remember)}
        >
          Open
        </button>
      </div>
    </dialog>
  )
}
