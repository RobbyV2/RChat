'use client'
import { useState } from 'react'
import { useAccount } from '../../lib/client/react'
import { derive, generate, seed } from '../../lib/backup_phrase'
import { b64u } from '../../lib/p2p/canonical'
import { publicOf } from '../../lib/p2p/keys'
import type { LinkedProvider } from '../../lib/types'
import { useConfirmation } from '../sso/use_confirmation'
import { Button } from '../controls'
import { Dialog } from '../ui'
import { PhraseWords } from './phrase_words'
import { ReAuthPrompt } from './reauth_prompt'
import { WordCheck } from './word_check'

export function PhraseSettings({ links }: { links: LinkedProvider[] }) {
  const [words, setWords] = useState<string[] | null>(null)
  const [saved, setSaved] = useState(false)
  return (
    <div>
      <Button
        onClick={() => {
          setSaved(false)
          setWords(generate())
        }}
      >
        Set or reset backup phrase
      </Button>
      {saved && <p role="status">Backup phrase saved</p>}
      {words && (
        <PhraseDialog
          words={words}
          links={links}
          close={() => setWords(null)}
          done={() => {
            setWords(null)
            setSaved(true)
          }}
        />
      )}
    </div>
  )
}
function PhraseDialog({
  words,
  links,
  close,
  done,
}: {
  words: string[]
  links: LinkedProvider[]
  close(): void
  done(): void
}) {
  const acct = useAccount(),
    current = useConfirmation()
  const [step, setStep] = useState<'save' | 'check' | 'confirm'>('save')
  const [key, setKey] = useState('')
  async function check() {
    const pk = b64u(publicOf(derive(await seed(words), 'account')))
    if (current()) {
      setKey(pk)
      setStep('confirm')
    }
  }
  return (
    <Dialog title="Set backup phrase" layer="confirm" onClose={close}>
      {step === 'save' ? (
        <>
          <p>
            Save these words in order. Confirming replaces your current backup phrase and signs out
            other sessions.
          </p>
          <PhraseWords words={words} />
          <Button variant="filled" size="md" onClick={() => setStep('check')}>
            I saved the words
          </Button>
        </>
      ) : step === 'check' ? (
        <WordCheck
          words={words}
          onDone={ok => {
            if (ok) void check()
          }}
          onSkip={() => void check()}
        />
      ) : (
        <ReAuthPrompt
          purpose="set"
          context={key}
          links={links}
          onBody={async reauth => {
            await acct.api.setRecovery(key, reauth)
            if (current()) done()
          }}
        />
      )}
    </Dialog>
  )
}
