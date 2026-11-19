'use client'

import { useEffect } from 'react'
import { create } from 'zustand'
import { applyWarning, configPatch, controlOf } from '../../lib/admin_config'
import { ApiError } from '../../lib/api'
import { api } from '../../lib/instances'
import { errorText, inSession, useStore } from '../../lib/store'
import type { AdminConfig, ConfigControl } from '../../lib/types'

// The server's config view, while the admin page is open.
export const useConfigStore = create<{ config: AdminConfig | null }>(() => ({ config: null }))

// While the page is `open`: loads the config view, and again whenever the settings change. An
// instance without the view shows no sources. Closing the page drops it.
export const useConfigSync = (open: boolean) => {
  const settings = useStore(s => s.settings)
  useEffect(() => {
    if (!open) return
    let live = true
    api
      .adminConfig()
      .then(config => {
        if (live) useConfigStore.setState({ config })
      })
      .catch(
        inSession((e: unknown) => {
          if (!(e instanceof ApiError && e.status === 404))
            useStore.getState().setError(errorText(e))
        })
      )
    return () => {
      live = false
    }
  }, [open, settings])
  useEffect(() => {
    if (open) return () => useConfigStore.setState({ config: null })
  }, [open])
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
