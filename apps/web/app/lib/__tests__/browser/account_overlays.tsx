import SsoPage from '../../../sso/page'
import { setupCallControls } from './call_controls'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { RelayPrompt } from '../../../components/relay_settings'
import { CallBanner } from '../../../components/voice_grid'
import { ConfirmDialog } from '../../../components/server_settings'
import { ContextMenu } from '../../../components/context_menu'
import { ServerRail } from '../../../components/server_rail'
import { ssoActions } from '../../sso_actions'
import { paletteCtx } from '../../actions/ctx'
import { registerAppActions } from '../../actions'
import { createRoot } from 'react-dom/client'
import { AppPreview } from '../../../components/app_preview'
import { P2pHome, P2pDialogs } from '../../../components/p2p/p2p_home'
import { ProviderButtons } from '../../../components/sso/provider_buttons'
import SettingsMenu from '../../../components/settings_menu'
import { ViewingPrompt } from '../../../components/viewing_prompt'
import { SwitcherDialog, AccountSwitcherTile } from '../../../components/account_switcher'
import { addAccount, addInstance } from '../../client/book'
import { useStore } from '../../store'
import { client } from '../../client/client'
import { AccountProvider } from '../../client/react'
import { AccountSession } from '../../client/session'
import { endpointsFrom, InstanceConnection } from '../../instances'
import type { Me } from '../../types'
import { Secret } from '../../secret'

const shown = client.shown()
const owner = new AccountSession(new InstanceConnection(endpointsFrom('https://owner.test', null)))
const me: Me = {
  username: 'reader',
  display_name: 'Reader',
  avatar_kind: 'identicon',
  avatar_color: null,
  banner_color: null,
  bio: null,
  is_site_admin: false,
  appear_offline: false,
  password_kind: 'text',
  servers: [{ name: 'garden', display_name: 'Garden', creator: null, is_admin: false }],
  servers_more: false,
  servers_cursor: null,
  dms: [],
  dms_more: false,
  dms_cursor: null,
}
shown.store.setState({ me, view: { kind: 'channel', server: 'garden', channelId: 1 } })
owner.store.setState({ me, view: { kind: 'channel', server: 'garden', channelId: 1 } })
shown.api.setToken(Secret.of('shown-token'))
owner.api.setToken(Secret.of('owner-token'))
for (const account of [shown, owner]) {
  account.store.setState(s => ({ guest: false, settings: { ...s.settings, p2p: true } }))
  account.identities.setAccount(me.username)
}

const events: string[] = []
function record(event: string) {
  events.push(event)
  document.body.dataset.events = JSON.stringify(events)
}
for (const account of [shown, owner]) {
  account.conn.ws.ensureConnected = () => {}
  account.conn.ws.sendVoice = message => {
    record(account.conn.host + ' ' + message.type)
    if (message.type === 'call_accept' || message.type === 'call_leave')
      queueMicrotask(() =>
        account.store.getState().applyWsEvent({
          type: 'call_state',
          dm_id: message.dm_id,
          dm_users: ['reader', 'peer'],
          from: 'peer',
          kind: 'rtc',
          video: false,
          state: message.type === 'call_accept' ? 'active' : 'ended',
        })
      )
    return true
  }
  account.rtc.join = async () => record(account.conn.host + ' capture')
}
owner.store.setState({ openDm: async (id, nav = 'push') => record('owner DM ' + id + ' ' + nav) })

function ring() {
  if (!client.calls.current())
    void client.calls.request({ account: shown, kind: 'voice' }, () => record('left shown call'))
  owner.store.setState({
    call: {
      dmId: 3,
      dmUsers: ['reader', 'peer'],
      state: 'ringing',
      from: 'peer',
      kind: 'rtc',
      video: false,
      since: null,
    },
  })
}
function promptBoth() {
  for (const account of [shown, owner])
    void account.relays
      .prompt('relay.' + account.conn.host)
      .then(answer => record(account.conn.host + ' ' + answer))
}
const callControls = setupCallControls(owner)
registerAppActions()
const router = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
  bfcacheId: 'test',
}
function RotationFixture({ account }: { account: AccountSession }) {
  const token = useStore(s => s.token)
  if (!token)
    return (
      <ProviderButtons
        account={account}
        providers={[{ id: 'work', name: 'Work' }]}
        clientReturn={false}
        back="/"
        username={account.credentialTarget ?? null}
        divider={false}
        onSuccess={() => {}}
      />
    )
  return (
    <>
      <button onClick={() => void account.store.getState().checkSession()}>Check session</button>
      <SettingsMenu />
    </>
  )
}

function EnrollmentFixture() {
  const switcher = useStore(s => s.activeDialog?.kind === 'account_switcher')
  return (
    <>
      <AccountSwitcherTile />
      <button
        onClick={() => shown.store.getState().openDialog({ kind: 'settings', section: 'p2p' })}
      >
        P2P settings
      </button>
      <P2pHome onMenu={() => {}} />
      <SettingsMenu />
      <P2pDialogs />
      {switcher && <SwitcherDialog initialManage={false} />}
    </>
  )
}
const root = createRoot(document.body.appendChild(document.createElement('main')))
if (location.pathname === '/sso/') {
  shown.credentialTarget = me.username
  shown.store.setState({ me: null })
  shown.api.setToken(null)
  const sibling = new AccountSession(
    new InstanceConnection(endpointsFrom(shown.conn.origin, null)),
    undefined,
    undefined,
    me.username
  )
  sibling.socketAllowed = false
  root.render(
    <AppRouterContext.Provider
      value={{
        ...router,
        replace: () => {
          root.render(
            <AccountProvider session={client.shown()}>
              <SettingsMenu />
            </AccountProvider>
          )
        },
      }}
    >
      <SsoPage />
    </AppRouterContext.Provider>
  )
} else if (location.search.startsWith('?first-password')) {
  const sibling = location.search.includes('sibling')
  const target = sibling ? owner : shown
  const callback = sibling
    ? new AccountSession(new InstanceConnection(endpointsFrom(target.conn.origin, null)))
    : target
  target.store.setState({ me: null })
  target.credentialTarget = sibling ? me.username : undefined
  target.socketAllowed = false
  const exchange = callback.api.ssoExchange
  callback.api.ssoExchange = async () => ({
    kind: 'session',
    user: { ...me, has_password: false },
    token: 'fixture-token',
    end_session: false,
  })
  void callback.store
    .getState()
    .ssoExchange({ code: 'fixture', verifier: 'fixture' }, () => true)
    .then(() => {
      callback.api.ssoExchange = exchange
      if (sibling) callback.store.dispose()
      client.show(target, 'none')
      const ctx = paletteCtx(target.store.getState(), target)
      document.body.dataset.paletteLink = String(ssoActions[0].available(ctx))
      target.store.getState().openDialog({ kind: 'settings', section: 'profile' })
      root.render(
        <AccountProvider session={target}>
          {location.search.includes('rotation') ? (
            <RotationFixture account={target} />
          ) : (
            <SettingsMenu />
          )}
        </AccountProvider>
      )
    })
} else if (location.search === '?enrollment') {
  shown.store.setState({ token: Secret.of('fixture-token') })
  const origin = shown.conn.origin
  void Promise.resolve(
    client.updateBook(book =>
      addAccount(
        addInstance(book, { origin, id: 'enrollment', name: 'Shown' }),
        origin,
        {
          username: me.username,
          display: null,
          avatar: null,
          added: 1,
          connect: true,
          identities: [],
        },
        origin
      )
    )
  ).then(() =>
    root.render(
      <AccountProvider session={shown}>
        <EnrollmentFixture />
      </AccountProvider>
    )
  )
} else
  root.render(
    <AccountProvider session={shown}>
      <button
        onClick={() => shown.store.getState().openDialog({ kind: 'settings', section: 'p2p' })}
      >
        P2P settings
      </button>
      <button
        onClick={() => owner.store.getState().openDialog({ kind: 'settings', section: 'sync' })}
      >
        Owner settings
      </button>
      <section aria-label="Shown account overlays">
        <ContextMenu />
        <AppPreview />
      </section>
      <button onClick={ring}>Ring owner</button>
      <button onClick={promptBoth}>Prompt both relays</button>
      <CallBanner />
      <RelayPrompt />
      <ViewingPrompt />
      <P2pDialogs />
      <SettingsMenu />
      <AccountProvider session={owner}>
        {callControls}
        <RelayPrompt />
        <ConfirmDialog />
        <SettingsMenu />
        <section aria-label="Owner account rail and overlays">
          <AppRouterContext.Provider value={router}>
            <ServerRail />
          </AppRouterContext.Provider>
          <ContextMenu />
          <AppPreview />
        </section>
      </AccountProvider>
    </AccountProvider>
  )
