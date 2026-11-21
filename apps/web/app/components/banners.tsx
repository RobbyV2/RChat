'use client'

import { useStore } from '../lib/store'
import { temporaryNotice } from '../lib/temp_password'
import { LabelText } from './instance_badge'
import { NoticeStack } from './notice_stack'

const bannerCls =
  'pointer-events-auto max-w-full self-center rounded-xl px-4 py-2 text-center text-sm shadow-elevation-2 sm:fixed sm:top-[calc(var(--safe-top)+4rem)] sm:left-1/2 sm:z-60 sm:w-max sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2'

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
      <span className="min-w-0">{temporaryNotice(temporary, Math.floor(Date.now() / 1000))}</span>
      <button
        onClick={() => openDialog({ kind: 'settings', section: 'profile' })}
        className="min-h-11 cursor-pointer rounded-full px-3 font-medium underline md:min-h-0"
      >
        Change it
      </button>
    </div>
  )
}

// The error or toast at the top, and the notices.
export function Banners() {
  const toast = useStore(s => s.toast)
  const error = useStore(s => s.error)
  return (
    <div className="pointer-events-none fixed inset-x-4 top-[calc(var(--safe-top)+4rem)] z-60 flex flex-col gap-2 sm:contents">
      {!error && !toast && <TemporaryPassword />}
      {error && (
        <div role="alert" className={`${bannerCls} bg-error-container text-on-error-container`}>
          <LabelText text={error} />
        </div>
      )}
      {toast && !error && (
        <div role="status" className={`${bannerCls} bg-inverse-surface text-inverse-on-surface`}>
          <LabelText text={toast.text} />
          {toast.name && (
            <>
              {' '}
              <span className="streamer font-medium">{toast.name}</span>
            </>
          )}
        </div>
      )}
      <NoticeStack />
    </div>
  )
}
