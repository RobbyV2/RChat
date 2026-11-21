'use client'

import { useStore } from '../../lib/store'
import { Dialog, filledDangerBtn, textBtn } from '../ui'
import { useAccountChanges } from './account_state'
import { AddToServerDialog, CreateAccountDialog, TempPasswordDialog } from './accounts'

// The confirm dialogs of the site admin's account actions. They open over the admin page and
// from the member and message menus.
export default function AdminDialogs() {
  const dialog = useStore(s => s.activeDialog)
  const isSiteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  if (!isSiteAdmin || !dialog) return null
  switch (dialog.kind) {
    case 'ban_confirm':
      return <BanConfirm username={dialog.username} />
    case 'delete_user_confirm':
      return <DeleteUserConfirm username={dialog.username} />
    case 'remove_phrase_confirm':
      return <RemovePhraseConfirm username={dialog.username} />
    case 'admin_create_account':
      return <CreateAccountDialog />
    case 'new_password_confirm':
      return <TempPasswordDialog username={dialog.username} />
    case 'sign_out_confirm':
      return <SignOutConfirm username={dialog.username} />
    case 'admin_add_to_server':
      return <AddToServerDialog username={dialog.username} />
    default:
      return null
  }
}

function UserConfirm({
  title,
  confirm,
  run,
  children,
}: {
  title: string
  confirm: string
  run: () => Promise<unknown>
  children: React.ReactNode
}) {
  const closeDialog = useStore(s => s.closeDialog)
  return (
    <Dialog title={title} onClose={closeDialog}>
      <p className="text-sm text-on-surface-variant">{children}</p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button onClick={() => void run().then(closeDialog)} className={filledDangerBtn}>
          {confirm}
        </button>
      </div>
    </Dialog>
  )
}

function DeleteUserConfirm({ username }: { username: string }) {
  const adminDeleteUser = useStore(s => s.adminDeleteUser)
  return (
    <UserConfirm title="Delete User" confirm="Delete" run={() => adminDeleteUser(username)}>
      Delete the account of <span className="streamer">{username}</span>? Every message they sent
      and their DMs are deleted. Servers they created are kept. The username becomes free to
      register again; use Ban site-wide to also block the name.
    </UserConfirm>
  )
}

function RemovePhraseConfirm({ username }: { username: string }) {
  const adminRemovePhrase = useStore(s => s.adminRemovePhrase)
  return (
    <UserConfirm
      title="Remove Backup Phrase"
      confirm="Remove"
      run={() => adminRemovePhrase(username)}
    >
      Remove the backup phrase of <span className="streamer">{username}</span>? They stay signed in
      and keep their password. This only removes a way back in, and they can set a new phrase.
    </UserConfirm>
  )
}

function SignOutConfirm({ username }: { username: string }) {
  const adminSignOut = useStore(s => s.adminSignOut)
  const changed = useAccountChanges(s => s.changed)
  return (
    <UserConfirm
      title="Sign Out Everywhere"
      confirm="Sign out"
      run={() => adminSignOut(username).then(changed)}
    >
      Sign <span className="streamer">{username}</span> out on every device? They keep their
      password and can sign in again.
    </UserConfirm>
  )
}

function BanConfirm({ username }: { username: string }) {
  const banUser = useStore(s => s.banUser)
  return (
    <UserConfirm title="Ban Site-wide" confirm="Ban" run={() => banUser(username)}>
      Ban <span className="streamer">{username}</span> site-wide? This deletes their account and
      every message they have sent, and permanently blocks the username.
    </UserConfirm>
  )
}
