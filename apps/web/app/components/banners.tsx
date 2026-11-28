'use client'

import { Name } from './name'
import { personCalled } from '../lib/names'
import { AccountProvider, useLiveSessions } from '../lib/client/react'
import { plays } from '../lib/motion/play'
import { useStore } from '../lib/store'
import { temporaryNotice } from '../lib/temp_password'
import { ViewActorTag } from './view_actor'
import { DeletionBanner } from './account_deletion'
import { LabelText } from './instance_badge'
import { NoticeStack } from './notice_stack'
import { time } from '../lib/platform/time'
import { bannerLook } from '../lib/controls'
import { Row } from './layout'
import { LinkButton } from './controls'

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
      className={`${bannerLook} bg-tertiary-container text-on-tertiary-container`}
    >
      <Row gap="md" lineGap="2xs" wrap justify="center">
        <ViewActorTag />
        <span className="min-w-0">
          {temporaryNotice(temporary, Math.floor(time().now() / 1000))}
        </span>
        <LinkButton
          onClick={() => openDialog({ kind: 'settings', section: 'profile' })}
          tone="inherit"
          underlined
        >
          Change it
        </LinkButton>
      </Row>
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
      {!error && !toast && <DeletionBanner className={bannerLook} />}
      {error && (
        <div role="alert" className={`${bannerLook} bg-error-container text-on-error-container`}>
          <ViewActorTag />
          <LabelText text={error} />
        </div>
      )}
      {toast && !error && (
        <div
          ref={plays('toast')}
          role="status"
          className={`${bannerLook} banner-toast bg-inverse-surface text-inverse-on-surface`}
        >
          <ViewActorTag peer={toast.peer} />
          <LabelText text={toast.text} />
          {toast.name && (
            <>
              {' '}
              <Name of={personCalled(toast.name)} look="font-medium" />
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
    <div className="banner-stack">
      <div>
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
