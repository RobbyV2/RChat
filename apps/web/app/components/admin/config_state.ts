'use client'
import { useAccount, accountBoundStore } from '../../lib/client/react'
import { useEffect } from 'react'
import { applyWarning, configPatch, controlOf } from '../../lib/admin_config'
import { ApiError } from '../../lib/api'
import { errorText, useStore } from '../../lib/store'
import type { AdminConfig, ConfigControl } from '../../lib/types'

// The server's config view, while the admin page is open.
export const useConfigStore = accountBoundStore<{ config: AdminConfig | null }>(
  account => account.adminConfig
)

// While the page is `open`: loads the config view, and again whenever the settings change. An
// instance without the view shows no sources. Closing the page drops it.
export const useConfigSync = (open: boolean) => {
  const ownerSession = useAccount()
  const settings = useStore(s => s.settings)
  useEffect(() => {
    if (!open) return
    let live = true
    const mark = ownerSession.lifetime.sessionMark()
    ownerSession.api
      .adminConfig()
      .then(config => {
        if (live && mark === ownerSession.lifetime.sessionMark())
          ownerSession.adminConfig.setState({ config })
      })
      .catch(
        ownerSession.lifetime.inSession((e: unknown) => {
          if (live && !(e instanceof ApiError && e.status === 404))
            ownerSession.store.getState().setError(errorText(e))
        })
      )
    return () => {
      live = false
    }
  }, [ownerSession, open, settings])
  useEffect(() => {
    if (open) return () => ownerSession.adminConfig.setState({ config: null })
  }, [ownerSession, open])
}

export const useControl = (key: string) => useConfigStore(s => controlOf(s.config, key))

export const usePinned = (key: string) => useControl(key)?.pinned ?? false

// Sets controls to what the server config says, after a confirm when that removes files or
// `ask` says what is about to change.
export const useApplyConfig = () => {
  const updateSettings = useStore(s => s.updateSettings)
  const askConfirm = useStore(s => s.askConfirm)
  return (controls: ConfigControl[], ask: string | null = null) => {
    const warning = applyWarning(controls)
    const run = () => void updateSettings(configPatch(controls))
    if (ask === null && warning === null) return run()
    askConfirm({
      title: 'Use Server Config',
      body: [ask, warning].filter(Boolean).join(' '),
      confirm: 'Use it',
      action: run,
    })
  }
}
