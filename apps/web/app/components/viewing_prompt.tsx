'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { AccountProvider, useAccount, useLiveSessions } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'
import type { PromptHost } from '../lib/viewing'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { Masked, TopDialog } from './ui'

export function ViewingPrompt() {
  const sessions = useLiveSessions()
  return sessions.map(owner => (
    <AccountProvider key={owner.renderKey} session={owner}>
      <AccountPrompt />
    </AccountProvider>
  ))
}

function AccountPrompt() {
  const { useViewing, syncViewingStorage, registerPromptHost } = useAccount().viewing
  const prompt = useViewing(s => s.prompt)
  const [host, setHost] = useState<PromptHost | null>(null)
  useEffect(() => {
    const mine = registerPromptHost()
    setHost(mine)
    return () => mine?.release()
  }, [registerPromptHost])
  useEffect(() => {
    window.addEventListener('storage', syncViewingStorage)
    return () => window.removeEventListener('storage', syncViewingStorage)
  }, [syncViewingStorage])
  return prompt && host ? <Warning key={prompt.target.key} prompt={prompt} host={host} /> : null
}

function Warning({
  prompt,
  host,
}: {
  prompt: NonNullable<ReturnType<AccountSession['viewing']['useViewing']['getState']>['prompt']>
  host: PromptHost
}) {
  const title = useId()
  const description = useId()
  const back = useRef<HTMLButtonElement>(null)
  const [remember, setRemember] = useState(false)
  const app = prompt.target.kind === 'app'
  return (
    <TopDialog
      labelledBy={title}
      describedBy={description}
      initialFocus={back}
      onTop
      onCancel={() => host.answer(prompt, false, false)}
    >
      <Stack gap="lg">
        <Stack gap="md">
          <h2 id={title} className="text-lg font-medium">
            {app ? 'Open this app?' : 'Open sensitive channel?'}
          </h2>
          <p id={description} className="text-sm text-on-surface-variant">
            {app
              ? 'This app shows content and forms created by its author. Open it if you trust the source.'
              : 'This channel is marked sensitive. Open it to view its content.'}
          </p>
          <p className="break-words font-medium">
            <Masked text={prompt.target.name} />
          </p>
          <label className="flex min-h-11 cursor-pointer items-center text-sm">
            <Row as="span" gap="sm">
              <input
                type="checkbox"
                className="cursor-pointer"
                checked={remember}
                onChange={e => setRemember(e.target.checked)}
              />
              Remember on this device
            </Row>
          </label>
        </Stack>
        <Row gap="sm" justify="end">
          <Button ref={back} size="md" onClick={() => host.answer(prompt, false, false)}>
            Cancel
          </Button>
          <Button variant="filled" size="md" onClick={() => host.answer(prompt, true, remember)}>
            Open
          </Button>
        </Row>
      </Stack>
    </TopDialog>
  )
}
