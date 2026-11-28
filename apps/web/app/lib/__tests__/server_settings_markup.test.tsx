import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ServerSettings from '../../components/server_settings'
import { serverSettingsSections, type ServerSettingsSection } from '../server_settings_sections'
import { useStore } from '../store'
import { ALL_PERMS, Perm } from '../types'
import { me, member, paged, serverDetail, textChannel } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  Object.assign(initial, saved)
  useStore.setState({ ...saved })
})

// The settings of `name` for alice: the owner, a member admin with only `perms`, or a plain
// member for 0.
const open = (perms: bigint | 'owner', name = 'garden', section?: ServerSettingsSection) => {
  Object.assign(initial, {
    token: 'tok',
    me: me('alice', {
      servers: [
        {
          name,
          display_name: 'Garden',
          creator: null,
          is_admin: perms === 'owner',
          banner_color: null,
          icon_image: null,
          icon_kind: 'identicon' as const,
          name_color: null,
          profiles_mode: 'all' as const,
          timed_out_remaining: null,
          timed_out_until: null,
        },
      ],
    }),
    servers: { [name]: serverDetail(name, { channels: [textChannel(1)] }) },
    members:
      perms === 'owner'
        ? {}
        : { [name]: paged([member('alice', perms === 0n ? {} : { is_admin: true, perms })]) },
    activeDialog: section
      ? { kind: 'server_settings', server: name, section }
      : { kind: 'server_settings', server: name },
  })
  return renderToStaticMarkup(<ServerSettings />)
}

const entries = (html: string) =>
  [...html.matchAll(/data-settings-section="([a-z]+)"/g)].map(m => m[1])

describe('hosted server settings', () => {
  test('sit in the large settings dialog with a search field', () => {
    const html = open('owner')
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Server Settings"')
    expect(html).toContain('md:w-[min(94vw,1120px)]')
    expect(html).toContain('placeholder="Search settings"')
    expect(html).toContain('title="Close" aria-label="Close"')
  })

  test('the owner sees every section', () => {
    const profiles = initial.settings.server_profiles !== false
    expect(entries(open('owner'))).toEqual(
      serverSettingsSections({ perms: ALL_PERMS, builtin: false, profiles })
    )
    expect(entries(open('owner'))).toContain('delete')
  })

  test('a member who manages only invites sees Invites and Access', () => {
    expect(entries(open(Perm.ManageInvites))).toEqual(['invites', 'access'])
  })

  test('a member whose permissions have no section sees only Invites, opened at once', () => {
    const html = open(Perm.DeleteMessages)
    expect(entries(html)).toEqual(['invites'])
    expect(html).not.toContain('Delete Server')
    expect(html).not.toContain('aria-label="Server name"')
    expect(html).toContain('data-screen="section"')
    expect(html).not.toContain('title="Back"')
  })

  test('a deep link opens its section, on phones as well', () => {
    const html = open('owner', 'garden', 'bans')
    expect(html).toContain('data-screen="section"')
    expect(html).toContain('data-settings-section="bans" aria-current="page"')
    expect(html).toContain('>Bans</h1>')
  })

  test('a deep link to a section the viewer does not see opens the first one', () => {
    const html = open(Perm.Kick, 'garden', 'delete')
    expect(entries(html)).toEqual(['invites', 'members', 'bans'])
    expect(html).toContain('data-settings-section="invites" aria-current="page"')
    expect(html).not.toContain('Delete Server')
  })

  test('a section does not repeat its name as its first heading', () => {
    for (const [section, label] of [
      ['roles', 'Roles'],
      ['channels', 'Channels'],
      ['bans', 'Bans'],
      ['integrations', 'Integrations'],
      ['audit', 'Audit log'],
      ['delete', 'Delete server'],
      ['access', 'Access'],
      ['messages', 'System messages'],
      ['widgets', 'Widgets'],
    ] as const) {
      const html = open('owner', 'garden', section)
      const body = html.slice(html.indexOf(`data-section-body="${section}"`))
      expect(new RegExp(`<(p|h3) class="[^"]*">${label}</(p|h3)>`, 'i').test(body)).toBe(false)
    }
    const members = open('owner', 'garden', 'members')
    expect(members).toContain('>Admins</p>')
    expect(members).toContain('>Members</p>')
    expect(open('owner', 'garden', 'overview')).toContain('aria-label="Server name"')
  })

  test('opening them lands on the list on phones and on Invites on wide screens', () => {
    const html = open('owner')
    expect(html).toContain('data-screen="list"')
    expect(html).toContain('data-settings-section="invites" aria-current="page"')
    expect(html).toContain('>Invites</h1>')
    expect(html).not.toContain('aria-label="Server name"')
  })

  test('nobody without a permission in the server gets them', () => {
    expect(open(0n)).toBe('')
  })
})
