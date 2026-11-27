import { beforeEach, describe, expect, test } from 'bun:test'
import { myPerms, roleColor, serverAdminPerms, useStore } from '../store'
import { ALL_PERMS, Perm } from '../types'
import { me, member, paged, role, serverDetail } from './fixtures'

beforeEach(() => {
  useStore.setState({ me: null, members: {}, servers: {} })
})

const perms = (server: string) => serverAdminPerms(useStore.getState(), server)

describe('serverAdminPerms', () => {
  test('no me -> 0', () => {
    expect(perms('s')).toBe(0)
  })

  test('loaded admin row with perms 0 -> ALL_PERMS', () => {
    useStore.setState({
      me: me('alice'),
      members: { s: paged([member('alice', { is_admin: true, perms: 0 })]) },
    })
    expect(perms('s')).toBe(ALL_PERMS)
  })

  test('loaded admin row narrows to its perms', () => {
    const p = Perm.Kick | Perm.DeleteMessages
    useStore.setState({
      me: me('alice'),
      members: { s: paged([member('alice', { is_admin: true, perms: p })]) },
    })
    expect(perms('s')).toBe(p)
  })

  test('non-admin row unions role perms', () => {
    useStore.setState({
      me: me('alice'),
      members: { s: paged([member('alice', { is_admin: false, role_ids: [1, 2] })]) },
      servers: {
        s: serverDetail('s', {
          roles: [role(1, '#f00', Perm.Kick), role(2, '#0f0', Perm.ManageChannels)],
        }),
      },
    })
    expect(perms('s')).toBe(Perm.Kick | Perm.ManageChannels)
  })

  test('non-admin with no matching roles -> 0', () => {
    useStore.setState({
      me: me('alice'),
      members: { s: paged([member('alice', { is_admin: false, role_ids: [] })]) },
      servers: { s: serverDetail('s', { roles: [role(1, '#f00', Perm.Kick)] }) },
    })
    expect(perms('s')).toBe(0)
  })

  test('no loaded row falls back to me.servers is_admin', () => {
    useStore.setState({
      me: me('alice', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: true }],
      }),
    })
    expect(perms('s')).toBe(ALL_PERMS)
    useStore.setState({
      me: me('alice', {
        servers: [{ name: 's', display_name: 's', creator: null, is_admin: false }],
      }),
    })
    expect(perms('s')).toBe(0)
  })
})

describe('myPerms site-admin shortcut', () => {
  test('site admin gets ALL_PERMS even with no membership', () => {
    useStore.setState({ me: me('root', { is_site_admin: true }) })
    expect(myPerms(useStore.getState(), 's')).toBe(ALL_PERMS)
    expect(serverAdminPerms(useStore.getState(), 's')).toBe(0)
  })

  test('non site admin defers to serverAdminPerms', () => {
    useStore.setState({
      me: me('alice'),
      members: { s: paged([member('alice', { is_admin: true, perms: Perm.Kick })]) },
    })
    expect(myPerms(useStore.getState(), 's')).toBe(Perm.Kick)
  })
})

describe('roleColor topmost', () => {
  const roles = [role(1, '#111', 0), role(2, '#222', 0), role(3, '#333', 0)]

  test('picks lowest-id (topmost) matching role', () => {
    expect(roleColor(roles, [3, 2])).toBe('#222')
    expect(roleColor(roles, [2, 1, 3])).toBe('#111')
  })

  test('no match or no roles -> undefined', () => {
    expect(roleColor(roles, [9])).toBeUndefined()
    expect(roleColor(undefined, [1])).toBeUndefined()
    expect(roleColor(roles, [])).toBeUndefined()
  })
})
