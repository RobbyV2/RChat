'use client'

import { useEffect, type ReactNode } from 'react'
import { summaryLine } from '../../lib/admin_config'
import { adminRow } from '../../lib/admin_rows'
import { home } from '../../lib/instances'
import { useStore } from '../../lib/store'
import type { RelayStatus } from '../../lib/types'
import { useConfigStore } from './config_state'
import { textBtn } from './touch'

const cardCls = 'flex min-w-0 flex-col gap-1 rounded-xl bg-surface-container px-4 py-3'
const cardTitleCls = 'text-xs font-medium tracking-wide text-on-surface-variant uppercase'

// The name of the stored sign-up choice.
const useSignUp = () => {
  const registration = useStore(s => s.settings.registration)
  const row = adminRow('registration')
  const options = row?.kind === 'choice' ? row.options : []
  return options.find(o => o.value === registration)?.label ?? registration
}

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`

const useCounts = () => {
  const overview = useStore(s => s.adminOverview)
  const load = useStore(s => s.loadAdminOverview)
  useEffect(() => {
    void load()
  }, [load])
  return overview
}

function SignUp({ children }: { children: ReactNode }) {
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 flex-1 text-sm break-words">{children}</span>
      <button
        onClick={() => openAdmin('features', null, 'registration')}
        className={`${textBtn} shrink-0`}
      >
        Change
      </button>
    </div>
  )
}

// What the list of sections shows on top on narrow screens.
export function OverviewSummary() {
  const signUp = useSignUp()
  const overview = useCounts()
  return (
    <div className={cardCls}>
      <SignUp>Sign-up: {signUp}</SignUp>
      {overview && (
        <p className="text-sm text-on-surface-variant">
          {count(overview.user_count, 'account', 'accounts')},{' '}
          {count(overview.server_count, 'server', 'servers')}
        </p>
      )}
    </div>
  )
}

const relayRows = (relay: RelayStatus): [string, string][] =>
  relay.enabled
    ? [
        ['Relay', relay.turn ? 'On (STUN and TURN)' : 'On (STUN only)'],
        ['Relay UDP port', relay.port === null ? 'Unknown' : String(relay.port)],
        [
          'Relay allocations',
          relay.allocations === null ? 'Runs in another process' : String(relay.allocations),
        ],
      ]
    : [['Relay', 'Off']]

export function OverviewSection() {
  const signUp = useSignUp()
  const overview = useCounts()
  const sfu = useStore(s => s.settings.sfu)
  const openAdmin = useStore(s => s.openAdmin)
  const config = useConfigStore(s => s.config)
  const info = home.info
  const facts: [string, string][] = [
    ...(info
      ? ([
          ['Version', info.version],
          ['API version', info.api_version],
        ] as [string, string][])
      : []),
    ...(overview?.relay ? relayRows(overview.relay) : []),
    ['Media server', sfu ? 'On' : 'Off'],
  ]
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className={cardCls}>
          <p className={cardTitleCls}>Sign-up</p>
          <SignUp>{signUp}</SignUp>
        </div>
        <div className={cardCls}>
          <p className={cardTitleCls}>Accounts and servers</p>
          {overview ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 text-sm break-words">
                  {count(overview.user_count, 'account', 'accounts')}
                </span>
                <button onClick={() => openAdmin('users')} className={`${textBtn} shrink-0`}>
                  Users
                </button>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 text-sm break-words">
                  {count(overview.server_count, 'server', 'servers')}
                </span>
                <button onClick={() => openAdmin('servers')} className={`${textBtn} shrink-0`}>
                  Servers
                </button>
              </div>
            </>
          ) : (
            <p className="text-sm text-on-surface-variant">Loading</p>
          )}
        </div>
        {overview && overview.temporary_count !== undefined && (
          <div className={cardCls}>
            <p className={cardTitleCls}>Temporary passwords</p>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 text-sm break-words">
                {overview.temporary_count === 0
                  ? 'None waiting'
                  : `${overview.temporary_count.toLocaleString()} not changed yet`}
              </span>
              <button onClick={() => openAdmin('users')} className={`${textBtn} shrink-0`}>
                Users
              </button>
            </div>
          </div>
        )}
        {config && (
          <div className={cardCls}>
            <p className={cardTitleCls}>Server config</p>
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 text-sm break-words">{summaryLine(config)}</span>
              <button onClick={() => openAdmin('config')} className={`${textBtn} shrink-0`}>
                Config
              </button>
            </div>
          </div>
        )}
      </div>
      <dl className="space-y-1 rounded-xl bg-surface-container px-4 py-3 text-sm">
        {facts.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-on-surface-variant">{label}</dt>
            <dd className="min-w-0 text-right break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
