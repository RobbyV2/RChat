'use client'
import { ask, sendTo } from '../../lib/asks'
import { useAccount, accountBoundStore } from '../../lib/client/react'
import type { AccountSession } from '../../lib/client/session'
import { useEffect, useMemo } from 'react'
import { applyWarning, configPatch, controlOf } from '../../lib/admin_config'
import { missing } from '../../lib/api_errors'
import { fromStore, type Load } from '../../lib/load'
import { time } from '../../lib/platform/time'
import { useStore } from '../../lib/store'
import type { AdminConfig, ConfigControl } from '../../lib/types'
import { Loaded, useLoad } from '../loaded'

// The server's config view, while the admin page is open.
export const useConfigStore = accountBoundStore<AccountConfig>(account => account.adminConfig)

type AccountConfig = ReturnType<AccountSession['adminConfig']['getState']>

// Which request for the view counts: a later one, or closing the page, leaves an earlier answer
// unused.
const asked = new WeakMap<AccountSession, number>()

const forget = (account: AccountSession) => {
  asked.set(account, (asked.get(account) ?? 0) + 1)
  account.adminConfig.setState({ config: null, trouble: null })
}

// Asks the instance for the view and keeps the answer, or why there is none.
const loadConfig = (account: AccountSession) => {
  const turn = (asked.get(account) ?? 0) + 1
  asked.set(account, turn)
  const mark = account.lifetime.sessionMark()
  const current = () => asked.get(account) === turn && mark === account.lifetime.sessionMark()
  void sendTo(account, ask.adminConfig()).then(
    config => {
      if (current()) account.adminConfig.setState({ config, trouble: null })
    },
    (error: unknown) => {
      if (!current()) return
      account.adminConfig.setState(
        missing(error) ? { config: null, trouble: { absent: true } } : { trouble: { error } }
      )
    }
  )
}

// While the page is `open`: loads the config view, and again whenever the settings change. An
// instance without the view shows no sources. Closing the page drops it.
export const useConfigSync = (open: boolean) => {
  const ownerSession = useAccount()
  const settings = useStore(s => s.settings)
  useEffect(() => {
    if (open) loadConfig(ownerSession)
  }, [ownerSession, open, settings])
  useEffect(() => {
    if (open) return () => forget(ownerSession)
  }, [ownerSession, open])
}

// The view as a load: here, still asked for, refused, or not something this instance has.
export const useConfigLoad = (): Load<AdminConfig> => {
  const account = useAccount()
  const source = useMemo(
    () =>
      fromStore<AccountConfig, AdminConfig>(
        time(),
        account.adminConfig,
        (state, make) => {
          if (state.trouble && 'error' in state.trouble) return make.failed(state.trouble.error)
          if (state.config) return make.ready(state.config)
          return state.trouble ? make.empty() : make.loading()
        },
        () => loadConfig(account)
      ),
    [account]
  )
  return useLoad(source)
}

// Says so where a screen draws from the view and it could not be loaded, with a way to ask
// again. Nothing while it is here or on its way.
export function ConfigTrouble() {
  return (
    <Loaded load={useConfigLoad()} skeleton={null} empty={null} what="the server config">
      {() => null}
    </Loaded>
  )
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
