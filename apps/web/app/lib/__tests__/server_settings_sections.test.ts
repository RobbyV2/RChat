import { describe, expect, test } from 'bun:test'
import {
  SERVER_SECTION_LABELS,
  serverSettingsRows,
  serverSettingsSections,
  type ServerSettingsSection,
} from '../server_settings_sections'
import { ALL_PERMS, Perm } from '../types'

const ALL = Object.keys(SERVER_SECTION_LABELS) as ServerSettingsSection[]
const sections = (perms: bigint, builtin = false, profiles = true) =>
  serverSettingsSections({ perms, builtin, profiles })

describe('serverSettingsSections', () => {
  test('the owner sees every section, Invites first', () => {
    expect(sections(ALL_PERMS)).toEqual(ALL)
    expect(sections(ALL_PERMS)[0]).toBe('invites')
  })

  test('the built-in server has no Delete, and its Access needs Manage server', () => {
    expect(sections(ALL_PERMS, true)).toEqual(ALL.filter(s => s !== 'delete'))
    expect(sections(Perm.ManageInvites, true)).toEqual(['invites'])
  })

  test('Server profiles shows only while the site has them on', () => {
    expect(sections(ALL_PERMS, false, false)).not.toContain('profiles')
  })

  test('a member who manages only invites sees Invites and the access it manages', () => {
    expect(sections(Perm.ManageInvites)).toEqual(['invites', 'access'])
  })

  test('a member with no section of their own sees only Invites', () => {
    expect(sections(Perm.DeleteMessages)).toEqual(['invites'])
    expect(sections(Perm.MentionEveryone)).toEqual(['invites'])
  })

  test('each permission opens its own sections', () => {
    const cases: [bigint, ServerSettingsSection[]][] = [
      [
        Perm.ManageServer,
        ['invites', 'overview', 'widgets', 'messages', 'uploads', 'profiles', 'access'],
      ],
      [Perm.ManageRoles, ['invites', 'roles', 'members']],
      [Perm.ManageChannels, ['invites', 'channels', 'integrations']],
      [Perm.ManageWebhooks, ['invites', 'integrations']],
      [Perm.ManageAdmins, ['invites', 'members']],
      [Perm.AssignRoles, ['invites', 'members']],
      [Perm.Kick, ['invites', 'members', 'bans']],
      [Perm.TimeoutMembers, ['invites', 'members']],
      [Perm.ViewAuditLog, ['invites', 'audit']],
      [Perm.DeleteServer, ['invites', 'delete']],
    ]
    for (const [perm, want] of cases) expect(sections(perm)).toEqual(want)
  })
})

describe('serverSettingsRows', () => {
  const owner = { perms: ALL_PERMS, builtin: false, profiles: true }
  const text = (section: ServerSettingsSection, viewer = owner) =>
    serverSettingsRows(section, viewer)
      .flatMap(r => [r.label, r.line ?? '', ...(r.keywords ?? [])])
      .join(' ')
      .toLowerCase()

  test('each section has one row of its own, with an id unique across the sections', () => {
    const rows = ALL.flatMap(section => serverSettingsRows(section, owner))
    expect(rows.map(r => r.section)).toEqual(ALL)
    expect(new Set(rows.map(r => r.id)).size).toBe(ALL.length)
    for (const row of rows) expect(row.label.length).toBeGreaterThan(0)
  })

  test('no row offers a server icon, which hosted servers do not have', () => {
    for (const section of ALL) expect(text(section)).not.toContain('icon')
  })

  test('on the built-in server, Overview has no rename and Access is guest participation', () => {
    const builtin = { ...owner, builtin: true }
    expect(text('overview')).toContain('rename')
    expect(text('overview', builtin)).not.toContain('rename')
    expect(text('access', builtin)).not.toContain('password')
    expect(text('access', builtin)).toContain('guest')
  })

  test('admin finds Members only for viewers who see the admin list', () => {
    expect(text('members')).toContain('admin')
    expect(text('members', { ...owner, perms: Perm.AssignRoles })).not.toContain('admin')
    expect(text('members', { ...owner, perms: Perm.ManageAdmins })).toContain('admin')
  })
})
