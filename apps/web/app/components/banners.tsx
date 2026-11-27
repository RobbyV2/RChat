'use client'

import { AccountProvider, useLiveSessions } from '../lib/client/react'
import { useStore } from '../lib/store'
import { temporaryNotice } from '../lib/temp_password'
import { ViewActorTag } from './view_actor'
import { DeletionBanner } from './account_deletion'
import { LabelText } from './instance_badge'
import { NoticeStack } from './notice_stack'

const bannerCls =
  'pointer-events-auto max-w-full self-center rounded-xl px-4 py-2 text-center text-sm shadow-elevation-2 sm:w-max sm:max-w-[calc(100vw-2rem)]'

// Shown while the account signed in with a temporary password it has not replaced, in the
// place of the error and the toast, which take it while they show. A dialog hides it.
function TemporaryPassword() {
  const temporary = useStore(s => s.me?.password_temporary ?? null)
  const openDialog = useStore(s => s.openDialog)
  const covered = useStore(s => s.activeDialog !== null)
  if (!temporary || covered) return null
  return (
    <div
      role="status"
      data-temporary-password
      className={`${bannerCls} flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-tertiary-container text-on-tertiary-container`}
    >
      <ViewActorTag />
      <span className="min-w-0">{temporaryNotice(temporary, Math.floor(Date.now() / 1000))}</span>
      <button
        onClick={() => openDialog({ kind: 'settings', section: 'profile' })}
        className="rounded-full px-3 font-medium underline outline-offset-2 focus-visible:outline-2 focus-visible:outline-current pointer-coarse:min-h-11"
      >
        Change it
      </button>
    </div>
  )
}

// The error or toast at the top, and the notices.
function AccountBanners() {
  const toast = useStore(s => s.toast)
  const error = useStore(s => s.error)
  return (
    <>
      {!error && !toast && <TemporaryPassword />}
      {!error && !toast && <DeletionBanner className={bannerCls} />}
      {error && (
        <div role="alert" className={`${bannerCls} bg-error-container text-on-error-container`}>
          <ViewActorTag />
          <LabelText text={error} />
        </div>
      )}
      {toast && !error && (
        <div
          role="status"
          className={`${bannerCls} bg-inverse-surface text-inverse-on-surface [&_[data-view-actor]]:me-1.5 [&_[data-view-actor]]:text-inherit`}
        >
          <ViewActorTag peer={toast.peer} />
          <LabelText text={toast.text} />
          {toast.name && (
            <>
              {' '}
              <span className="streamer font-medium">{toast.name}</span>
            </>
          )}
        </div>
      )}
    </>
  )
}

export function Banners() {
  const sessions = useLiveSessions()
  return (
    <div className="pointer-events-none fixed inset-x-4 top-[calc(var(--safe-top)+4rem)] z-banner flex flex-col gap-2 sm:contents">
      <div className="contents sm:pointer-events-none sm:fixed sm:top-[calc(var(--safe-top)+4rem)] sm:left-1/2 sm:z-banner sm:flex sm:-translate-x-1/2 sm:flex-col sm:gap-2">
        {sessions.map(session => (
          <AccountProvider key={session.renderKey} session={session}>
            <AccountBanners />
          </AccountProvider>
        ))}
      </div>
      <NoticeStack sessions={sessions} />
    </div>
  )
}
