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
import { Dialog } from './ui'

// Settings > Account: asks the instance to delete the account after its wait.
export function DeleteAccount({ links }: { links: LinkedProvider[] }) {
  const pending = useStore(s => s.me?.delete_at ?? null)
  const keep = useStore(s => s.keepAccount)
  const [open, setOpen] = useState(false)
  if (pending !== null)
    return (
      <div data-account-deletion="pending" className="flex flex-col items-start gap-2">
        <p role="status" className="text-sm text-on-surface-variant">
          {deletionNotice(pending, Math.floor(Date.now() / 1000))}
        </p>
        <Button onClick={() => void keep()}>Keep account</Button>
      </div>
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
      <p className="text-sm text-on-surface-variant">{DELETION_TEXT}</p>
      {held && (
        <div className="my-4 flex flex-col gap-1">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-on-surface md:min-h-0">
            <input
              type="checkbox"
              data-account-deletion="p2p"
              checked={removeP2p}
              onChange={e => setRemoveP2p(e.target.checked)}
            />
            {DELETION_P2P_LABEL}
          </label>
          <p className="text-xs text-on-surface-variant">
            {removeP2p
              ? 'They leave every P2P server and are deleted from this browser with their device keys.'
              : DELETION_P2P_KEPT}
          </p>
        </div>
      )}
      <div className={held ? '' : 'mt-4'}>
        <ReAuthPrompt
          purpose="delete_account"
          links={links}
          onBody={reauth => remove(reauth, removeP2p)}
        />
      </div>
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
      className={`${className} flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-error-container text-on-error-container`}
    >
      <span className="min-w-0">{deletionNotice(pending, Math.floor(Date.now() / 1000))}</span>
      <button
        type="button"
        onClick={() => void keep()}
        className="rounded-full px-3 font-medium underline outline-offset-2 focus-visible:outline-2 focus-visible:outline-current pointer-coarse:min-h-11"
      >
        Keep account
      </button>
    </div>
  )
}
