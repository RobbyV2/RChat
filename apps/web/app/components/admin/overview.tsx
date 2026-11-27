'use client'
import { useConn } from '../../lib/client/react'
import { useEffect, type ReactNode } from 'react'
import { summaryLine } from '../../lib/admin_config'
import { adminRow } from '../../lib/admin_rows'
import { useStore } from '../../lib/store'
import type { RelayStatus } from '../../lib/types'
import { useConfigStore } from './config_state'
import { Button } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'

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

function Card({ children }: { children: ReactNode }) {
  return (
    <Surface tone="base" radius="lg" pad="lg" gap="2xs">
      {children}
    </Surface>
  )
}

// A line of a card and the button that opens where it is changed.
function Line({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <Row gap="sm">
      <span className="min-w-0 flex-1 text-sm break-words">{children}</span>
      {action}
    </Row>
  )
}

function SignUp({ children }: { children: ReactNode }) {
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <Line
      action={
        <Button onClick={() => openAdmin('features', null, 'registration')} place="shrink-0">
          Change
        </Button>
      }
    >
      {children}
    </Line>
  )
}

// What the list of sections shows on top on narrow screens.
export function OverviewSummary() {
  const signUp = useSignUp()
  const overview = useCounts()
  return (
    <Card>
      <SignUp>Sign-up: {signUp}</SignUp>
      {overview && (
        <p className="text-sm text-on-surface-variant">
          {count(overview.user_count, 'account', 'accounts')},{' '}
          {count(overview.server_count, 'server', 'servers')}
        </p>
      )}
    </Card>
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
  const conn = useConn()
  const signUp = useSignUp()
  const overview = useCounts()
  const sfu = useStore(s => s.settings.sfu)
  const openAdmin = useStore(s => s.openAdmin)
  const config = useConfigStore(s => s.config)
  const info = conn.info
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
    <Stack gap="md">
      <Grid cols={{ base: 1, sm: 2 }} gap="md">
        <Card>
          <p className={cardTitleCls}>Sign-up</p>
          <SignUp>{signUp}</SignUp>
        </Card>
        <Card>
          <p className={cardTitleCls}>Accounts and servers</p>
          {overview ? (
            <>
              <Line
                action={
                  <Button onClick={() => openAdmin('users')} place="shrink-0">
                    Users
                  </Button>
                }
              >
                {count(overview.user_count, 'account', 'accounts')}
              </Line>
              <Line
                action={
                  <Button onClick={() => openAdmin('servers')} place="shrink-0">
                    Servers
                  </Button>
                }
              >
                {count(overview.server_count, 'server', 'servers')}
              </Line>
            </>
          ) : (
            <p className="text-sm text-on-surface-variant">Loading</p>
          )}
        </Card>
        {overview && overview.temporary_count !== undefined && (
          <Card>
            <p className={cardTitleCls}>Temporary passwords</p>
            <Line
              action={
                <Button onClick={() => openAdmin('users')} place="shrink-0">
                  Users
                </Button>
              }
            >
              {overview.temporary_count === 0
                ? 'None waiting'
                : `${overview.temporary_count.toLocaleString()} not changed yet`}
            </Line>
          </Card>
        )}
        {config && (
          <Card>
            <p className={cardTitleCls}>Server config</p>
            <Line
              action={
                <Button onClick={() => openAdmin('config')} place="shrink-0">
                  Config
                </Button>
              }
            >
              {summaryLine(config)}
            </Line>
          </Card>
        )}
      </Grid>
      <Surface tone="base" radius="lg" pad="lg">
        <Stack as="dl" gap="2xs">
          {facts.map(([label, value]) => (
            <Row key={label} gap="md" justify="between">
              <dt className="text-sm text-on-surface-variant">{label}</dt>
              <dd className="min-w-0 text-right text-sm break-words">{value}</dd>
            </Row>
          ))}
        </Stack>
      </Surface>
    </Stack>
  )
}
