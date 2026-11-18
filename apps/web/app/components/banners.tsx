'use client'

import { useStore } from '../lib/store'
import { LabelText } from './instance_badge'
import { NoticeStack } from './notice_stack'

const bannerCls =
  'pointer-events-auto max-w-full self-center rounded-xl px-4 py-2 text-center text-sm shadow-elevation-2 sm:fixed sm:top-[calc(var(--safe-top)+4rem)] sm:left-1/2 sm:z-60 sm:w-max sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2'

// The error or toast at the top, and the notices.
export function Banners() {
  const toast = useStore(s => s.toast)
  const error = useStore(s => s.error)
  return (
    <div className="pointer-events-none fixed inset-x-4 top-[calc(var(--safe-top)+4rem)] z-60 flex flex-col gap-2 sm:contents">
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
