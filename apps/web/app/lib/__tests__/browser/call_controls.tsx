import { CallButtons } from '../../../components/call_buttons'
import { P2pCallButtons } from '../../../components/p2p/p2p_call'
import { p2pName } from '../../names'
import { client } from '../../client/client'
import type { AccountSession } from '../../client/session'
import { Calls } from '../../p2p/calls'
import type { Session } from '../../p2p/session'

export function setupCallControls(owner: AccountSession) {
  const dm = {
    id: 4,
    other: { ...owner.store.getState().me!, username: 'other', display_name: 'Other' },
    is_self: false,
  }
  owner.store.setState({ dms: [dm], callRoute: 'server' })
  // The contact is online. Cancelling at the switch prompt must precede sending any frame.
  const contact = {
    state: 'ready',
    send: () => {
      throw new Error('Unexpected ring')
    },
  } as unknown as Session
  owner.identities.get()!.put.calls(
    new Calls({
      me: () => 'local',
      sessions: () => [contact],
      mutual: () => true,
      roomOf: ik => ik,
      name: ik => ik,
      media: owner.rtc,
      plan: () => owner.relays.check('auto'),
      hidesIp: () => false,
      consent: async () => null,
      log: async () => {},
      missed: () => {},
      busy: () => !!client.calls.current(),
      muted: () => false,
      save: () => {},
      notice: () => {},
      claim: (leave, valid) =>
        client.calls.request({ account: owner, kind: 'p2p-call', identity: 'local' }, leave, valid),
    })
  )
  return (
    <>
      <section aria-label="Other DM">
        <CallButtons dm={dm} />
      </section>
      <section aria-label="Online contact">
        <P2pCallButtons peer="contact" name={p2pName('Contact')} online canCall />
      </section>
    </>
  )
}
