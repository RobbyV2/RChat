import { afterAll, afterEach, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime'
import { AuditRow } from '../../components/audit_log'
import { ChatSourceProvider, type ChatSource } from '../../components/chat_source'
import { MarkdownMessage } from '../../components/markdown_message'
import { MemberAvatar } from '../../components/p2p/p2p_badge'
import {
  ProfileEditor,
  ProfileReset,
  ProfilesModeField,
  accountAvatar,
  type ProfileEditorSource,
  type ProfileResetSource,
} from '../../components/server_profile_dialog'
import { ShownAvatar, ShownName } from '../../components/shown_user'
import { TypingIndicator } from '../../components/typing_indicator'
import { LOCK_CHOICES, RESET_LABELS } from '../profile_reset'
import { EMPTY_DRAFT } from '../server_profile_editor'
import { resetSessionCaches, useStore } from '../store'
import type { AuditEntry, MemberLook } from '../types'
import { me, member, msg, serverDetail, user } from './fixtures'

const initial = useStore.getInitialState()
const saved = { ...initial }

afterEach(() => {
  Object.assign(initial, saved)
})

afterAll(resetSessionCaches)

const router = {
  push: () => {},
  replace: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance

const render = (node: ReactElement) =>
  renderToStaticMarkup(<AppRouterContext.Provider value={router}>{node}</AppRouterContext.Provider>)

const robert: MemberLook = { name: 'Robert', avatar_kind: 'color', avatar_color: '#112233' }
const bob = user('bob', { display_name: 'Bob' })

// Bob set a name and a color avatar in server `s`.
const withLook = (mode: 'all' | 'no_names' | 'off' = 'all') =>
  Object.assign(initial, {
    settings: { ...saved.settings, server_profiles: true, display_names: true },
    servers: { s: serverDetail('s', { profiles_mode: mode }) },
    memberInfo: { s: { bob: member('bob', { display_name: 'Bob', profile: robert }) } },
    typingOn: true,
    typing: { c1: { bob: { name: 'Bob', until: Date.now() + 5000 } } },
  })

test('a name and an avatar drawn in a server are the ones the member set there', () => {
  withLook()
  expect(render(<ShownName user={bob} server="s" />)).toContain('Robert')
  expect(render(<ShownName user={bob} server="s" />)).toContain('(bob)')
  expect(render(<ShownName user={bob} server={null} />)).toBe('Bob')
  expect(render(<ShownName user={bob} server="other" />)).toBe('Bob')
  expect(render(<ShownAvatar user={bob} server="s" size={20} />)).toContain('#112233')
  expect(render(<ShownAvatar user={bob} server={null} size={20} />)).not.toContain('#112233')
  withLook('no_names')
  expect(render(<ShownName user={bob} server="s" />)).toBe('Bob')
  expect(render(<ShownAvatar user={bob} server="s" size={20} />)).toContain('#112233')
  withLook('off')
  expect(render(<ShownAvatar user={bob} server="s" size={20} />)).not.toContain('#112233')
})

test('an audit row names people as the server shows them now, the username always after', () => {
  withLook()
  const kick: AuditEntry = {
    id: 1,
    action: 'member.kick',
    actor: user('alice', { display_name: 'Alice' }),
    staff: false,
    target: {
      kind: 'user',
      id: null,
      name: 'bob',
      user: user('bob', { display_name: 'Bobby' }),
      staff: false,
      deleted: false,
    },
    details: {},
    hidden: false,
    created_at: 0,
  }
  // The space before the username is padding.
  const text = (html: string) => html.replace(/<[^>]+>/g, '')
  expect(text(render(<AuditRow entry={kick} server="s" />))).toContain('Alice kicked Robert(bob)')
  expect(text(render(<AuditRow entry={kick} />))).toContain('Alice kicked Bobby(bob)')
  const renamed = { ...kick, action: 'member.profile_name', details: { old: 'Rob', new: 'Robert' } }
  expect(text(render(<AuditRow entry={renamed} server="s" />))).toContain(
    'changed their server name from Rob to Robert'
  )
})

test('the typing line of a server channel names typers as the server shows them', () => {
  withLook()
  expect(render(<TypingIndicator scope="c1" server="s" bg="" />)).toContain('Robert (bob)')
  expect(render(<TypingIndicator scope="c1" bg="" />)).toContain('>Bob<')
  expect(render(<TypingIndicator scope="c1" server="s" bg="" names={['Peer']} />)).toContain(
    '>Peer<'
  )
})

test('a mention pill keeps the handle: the username with the server name as its tooltip, the name in a P2P server', () => {
  withLook()
  Object.assign(initial, {
    token: 'tok',
    me: me('carol'),
    view: { kind: 'channel', server: 's', channelId: 1 },
    servers: {
      s: serverDetail('s', {
        profiles_mode: 'all',
        channels: [{ id: 1, name: 'general', kind: 'text', slowmode_seconds: 0 }],
      }),
    },
  })
  const hosted = render(
    <MarkdownMessage message={msg(1, { author: user('carol'), content: 'hi @bob' })} />
  )
  expect(hosted).toContain('data-mention="bob"')
  expect(hosted).toContain('title="Robert"')
  expect(hosted).toContain('>@Bob</span>')
  const key = 'Bx7pW2'.padEnd(43, 'b')
  const source: ChatSource = {
    toggleReaction: () => {},
    loadReactors: () => Promise.resolve([]),
    openReactPicker: () => {},
    known: (_m, names) => names.filter(n => n === 'skipper').join('\n'),
    user: () => user(key, { display_name: 'Skipper' }),
    mine: () => false,
    self: 'me',
    people: () => [],
  }
  const p2p = render(
    <ChatSourceProvider value={source}>
      <MarkdownMessage message={msg(2, { author: user('me'), content: 'hi @Skipper' })} />
    </ChatSourceProvider>
  )
  expect(p2p).toContain('>@Skipper</span>')
  expect(p2p.includes(key)).toBe(false)
  expect(p2p.includes('title="Robert"')).toBe(false)
})

test('a P2P member avatar keeps the key picture under the avatar set for the server', () => {
  const members = [
    { ik: 'k1', name: 'Bob', av: { kind: 'color' as const, bg: '#112233' } },
    { ik: 'k2', name: 'Carol' },
  ]
  const disc = render(<MemberAvatar members={members} ik="k1" size={32} />)
  expect(disc).toContain('background-color:#112233')
  expect(disc).toContain('<img')
  const plain = render(<MemberAvatar members={members} ik="k2" size={32} />)
  expect(plain.startsWith('<img')).toBe(true)
  expect(render(<MemberAvatar members={undefined} ik="k2" size={32} />)).toBe(plain)
})

const source = (over: Partial<ProfileEditorSource> = {}): ProfileEditorSource => ({
  account: user('alice', { display_name: 'Alice' }),
  accountBio: 'From my account',
  accountBanner: null,
  origin: 'account',
  mode: 'all',
  names: true,
  saved: { ...EMPTY_DRAFT, name: 'Captain', bio: 'Sails' },
  lock: { locked: false },
  avatar: accountAvatar,
  handles: true,
  save: async () => null,
  clear: async () => null,
  ...over,
})

const editor = (over: Partial<ProfileEditorSource> = {}) =>
  render(<ProfileEditor source={source(over)} onClose={() => {}} />)

test('the editor shows the stored profile, a preview and what falls back to the account', () => {
  const html = editor()
  expect(html).toContain('value="Captain"')
  expect(html).toContain('placeholder="Alice"')
  expect(html).toContain('Use account name')
  expect(html).toContain('Use account description')
  expect(html).toContain('As on your account')
  expect(html).toContain('data-profile-preview')
  expect(html).toContain('(alice)')
  expect(html).toContain('>Save<')
  expect(html).toContain('>Reset all<')
  expect(html).not.toContain('data-profile-locked')
  const p2p = editor({ origin: 'P2P profile', handles: false })
  expect(p2p).toContain('Use P2P profile name')
  expect(p2p).not.toContain('(alice)')
})

test('a locked profile is read-only and says when it can be edited again', () => {
  const html = editor({ lock: { locked: true, until: null } })
  expect(html).toContain('data-profile-locked')
  expect(html).toContain(
    'A moderator reset your server profile. You can edit it again once a moderator unlocks it.'
  )
  expect(html).toContain('<fieldset disabled=""')
  expect(html).not.toContain('>Save<')
  expect(html).toContain('>Close<')
  expect(editor({ lock: { locked: true, until: 4102444800 } })).toContain(
    'or once a moderator unlocks it.'
  )
})

test('the editor follows the mode of the place and waits for the stored profile', () => {
  const noNames = editor({ mode: 'no_names', names: false })
  expect(noNames).toContain('data-profile-no-names')
  expect(noNames).toContain('This server doesn&#x27;t use server names.')
  expect(noNames).not.toContain('value="Captain"')
  expect(noNames).not.toContain('Captain')
  const siteOff = editor({ mode: 'all', names: false })
  expect(siteOff).toContain('Names are off on this site.')
  expect(siteOff).not.toContain('use server names')
  expect(editor({ mode: 'off' })).toContain('Server profiles are off in this server.')
  expect(editor({ saved: null })).toContain('Loading')
  expect(editor({ saved: null, failed: true })).toContain('load your server profile')
})

const resetSource = (over: Partial<ProfileResetSource> = {}): ProfileResetSource => ({
  user: user('bob', { display_name: 'Robert' }),
  subtitle: '@bob',
  name: 'Robert',
  lock: { locked: false },
  reasons: true,
  avatar: accountAvatar,
  submit: async () => null,
  unlock: async () => null,
  ...over,
})

const reset = (over: Partial<ProfileResetSource> = {}) =>
  render(<ProfileReset source={resetSource(over)} onClose={() => {}} />)

test('the reset dialog lists each part, the lock choices, a reason and the name about to go', () => {
  const html = reset()
  for (const label of Object.values(RESET_LABELS)) expect(html).toContain(label)
  for (const c of LOCK_CHOICES) expect(html).toContain(`>${c.label}<`)
  expect(html).toContain('@bob')
  expect(html).toContain('(Robert)')
  expect(html).toContain('Reason')
  expect(html).not.toContain('data-profile-reset-locked')
  const p2p = reset({ subtitle: null, name: null, reasons: false })
  expect(p2p).not.toContain('Reason')
  expect(p2p).not.toContain('@bob')
  expect(p2p).not.toContain('data-profile-reset-who')
  expect(/data-profile-reset-who[^>]*>Bob</.test(reset({ subtitle: 'Bob', reasons: false }))).toBe(
    true
  )
  const locked = reset({ lock: { locked: true, until: null } })
  expect(locked).toContain('Locked until unlocked')
  expect(locked).toContain('>Unlock<')
})

test('the Server profiles choice marks the mode in use and can be read-only', () => {
  const html = render(<ProfilesModeField mode="no_names" onChange={async () => {}} />)
  expect(html).toContain('aria-checked="true" class')
  expect(html.match(/aria-checked="true"/g)?.length).toBe(1)
  expect(/aria-checked="true"[^>]*>Everything but names</.test(html)).toBe(true)
  expect(html).toContain('>Everything<')
  expect(html).toContain('>Off<')
  const fixed = render(<ProfilesModeField mode="all" disabled onChange={async () => {}} />)
  expect(fixed.match(/disabled=""/g)?.length).toBe(3)
})
