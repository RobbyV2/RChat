import type { AccountSession } from './session'
import type { ConfirmRequest } from '../store_types'

export interface CallSource {
  account: AccountSession
  identity?: string
  kind: 'voice' | 'dm' | 'p2p-call' | 'p2p-voice'
}

export interface CallClaim extends CallSource {
  release(): void
  current(): boolean
}

export type ClaimMedia = (leave: () => void, valid: () => boolean) => Promise<CallClaim | null>

export class CallGuard {
  private active: (CallClaim & { leave(): void }) | null = null
  private expanded: CallClaim | null = null
  expandedCall = () => this.expanded

  expand(call: CallClaim) {
    if (call !== this.active || this.expanded === call) return
    this.expanded = call
    this.publish()
  }

  collapse = () => {
    if (!this.expanded) return
    this.expanded = null
    this.publish()
  }

  private listeners = new Set<() => void>()
  private pending: { account: AccountSession; cancel(): void } | null = null

  current = (): CallClaim | null => this.active
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private publish() {
    for (const listener of this.listeners) listener()
  }

  end(account: AccountSession) {
    if (this.pending?.account === account) this.pending.cancel()
    const active = this.active
    if (active?.account === account) {
      active.release()
      active.leave()
    }
  }

  request(source: CallSource, leave: () => void, valid: () => boolean = () => true) {
    const previous = this.active
    this.pending?.cancel()
    const claim = (): CallClaim | null => {
      if (!valid() || (this.active && this.active !== previous)) return null
      if (previous && this.active === previous) {
        previous.release()
        previous.leave()
      }
      const next = {
        ...source,
        leave,
        current: () => this.active === next,
        release: () => {
          if (this.active !== next) return
          this.expanded = null
          this.active = null
          this.publish()
        },
      }
      this.active = next
      this.publish()
      return next
    }
    if (!previous) return Promise.resolve(claim())
    const { account } = source
    return new Promise<CallClaim | null>(resolve => {
      let settled = false
      const finish = (accepted: boolean) => {
        if (settled) return
        settled = true
        unsubscribe()
        this.pending = null
        if (account.store.getState().confirm === request) account.store.getState().closeConfirm()
        resolve(accepted ? claim() : null)
      }
      const request: ConfirmRequest = {
        title: 'Switch call?',
        bodyName: previous.account.id,
        body: `This ends your call as ${previous.account.id}.`,
        confirm: 'Switch',
        action: () => finish(true),
      }
      const unsubscribe = account.store.subscribe((now, before) => {
        if (now.confirm === request && !valid()) finish(false)
        else if (before.confirm === request && now.confirm !== request)
          queueMicrotask(() => finish(false))
      })
      this.pending = { account, cancel: () => finish(false) }
      account.store.getState().askConfirm(request)
    })
  }
}
