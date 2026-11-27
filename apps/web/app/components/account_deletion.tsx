'use client'

import { useState } from 'react'
import {
  DELETION_P2P_KEPT,
  DELETION_P2P_LABEL,
  DELETION_TEXT,
  deletionNotice,
  holdsIdentities,
} from '../lib/account_deletion'
import { useAccount, useStore } from '../lib/client/react'
import type { LinkedProvider } from '../lib/types'
import { ReAuthPrompt } from './backup_phrase/reauth_prompt'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { Dialog } from './ui'

// Settings > Account: asks the instance to delete the account after its wait.
export function DeleteAccount({ links }: { links: LinkedProvider[] }) {
  const pending = useStore(s => s.me?.delete_at ?? null)
  const keep = useStore(s => s.keepAccount)
  const [open, setOpen] = useState(false)
  if (pending !== null)
    return (
      <Stack data-account-deletion="pending" gap="sm" align="start">
        <p role="status" className="text-sm text-on-surface-variant">
          {deletionNotice(pending, Math.floor(Date.now() / 1000))}
        </p>
        <Button onClick={() => void keep()}>Keep account</Button>
      </Stack>
    )
  return (
    <>
      <Button variant="danger" data-account-deletion="ask" onClick={() => setOpen(true)}>
        Delete account
      </Button>
      {open && <DeleteDialog links={links} close={() => setOpen(false)} />}
    </>
  )
}

function DeleteDialog({ links, close }: { links: LinkedProvider[]; close(): void }) {
  const account = useAccount()
  const remove = useStore(s => s.deleteAccount)
  const [held] = useState(() => holdsIdentities(account))
  const [removeP2p, setRemoveP2p] = useState(false)
  return (
    <Dialog title="Delete account?" compact layer="confirm" onClose={close}>
      <Stack gap="lg">
        <p className="text-sm text-on-surface-variant">{DELETION_TEXT}</p>
        {held && (
          <Stack gap="2xs">
            <Row
              as="label"
              gap="md"
              text="sm"
              ink="strong"
              look="min-h-11 cursor-pointer"
              place="md:min-h-0"
            >
              <input
                type="checkbox"
                data-account-deletion="p2p"
                checked={removeP2p}
                onChange={e => setRemoveP2p(e.target.checked)}
              />
              {DELETION_P2P_LABEL}
            </Row>
            <p className="text-xs text-on-surface-variant">
              {removeP2p
                ? 'They leave every P2P server and are deleted from this browser with their device keys.'
                : DELETION_P2P_KEPT}
            </p>
          </Stack>
        )}
        <ReAuthPrompt
          purpose="delete_account"
          links={links}
          onBody={reauth => remove(reauth, removeP2p)}
        />
      </Stack>
    </Dialog>
  )
}

// The notice at the top of the app while the account waits to be deleted.
export function DeletionBanner({ className }: { className: string }) {
  const pending = useStore(s => s.me?.delete_at ?? null)
  const keep = useStore(s => s.keepAccount)
  const covered = useStore(s => s.activeDialog !== null)
  if (pending === null || covered) return null
  return (
    <div
      role="status"
      data-account-deletion="banner"
      className={`${className} bg-error-container text-on-error-container`}
    >
      <Row gap="md" justify="center" wrap>
        <span className="min-w-0">{deletionNotice(pending, Math.floor(Date.now() / 1000))}</span>
        <button
          type="button"
          onClick={() => void keep()}
          className="rounded-full px-3 font-medium underline outline-offset-2 focus-visible:outline-2 focus-visible:outline-current pointer-coarse:min-h-11"
        >
          Keep account
        </button>
      </Row>
    </div>
  )
}
