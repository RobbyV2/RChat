import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const components = join(import.meta.dir, '..', 'apps/web/app/components')

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (name === '__tests__') return []
    if (statSync(path).isDirectory()) return files(path)
    return name.endsWith('.tsx') ? [path] : []
  })

// What draws a person: their name or their picture.
const draws = /\b(NameWithUsername|FitName|UserAvatar|KeyAvatar)\b|\.display_name\b/

// What resolves a person to how a server shows them (lib/server_profile.ts and the hooks and
// components over it).
const resolves =
  /\b(useShown|useShownOrNull|useShownMembers|useLook|ShownName|ShownAvatar|shownUser|shownIn|shownTypers|previewUser|roomLookOf|MemberAvatar|memberUser)\b/

// Components that draw a member or an author inside a server, hosted or P2P.
const IN_A_SERVER = [
  'audit_log.tsx',
  'ban_dialog.tsx',
  'channel_sidebar.tsx',
  'inbox.tsx',
  'markdown_message.tsx',
  'member_sidebar.tsx',
  'message_composer.tsx',
  'message_link_card.tsx',
  'message_pane.tsx',
  'p2p/p2p_badge.tsx',
  'p2p/p2p_search.tsx',
  'p2p/p2p_server_profile.tsx',
  'p2p/p2p_server_roles.tsx',
  'p2p/p2p_server_settings.tsx',
  'p2p/p2p_server_view.tsx',
  'p2p/p2p_thread.tsx',
  'p2p/p2p_voice.tsx',
  'pins.tsx',
  'poll_card.tsx',
  'profile_card.tsx',
  'reactions.tsx',
  'replies.tsx',
  'search_panel.tsx',
  'server_members.tsx',
  'server_profile_dialog.tsx',
  'server_settings.tsx',
  'shown_user.tsx',
  'system_messages.tsx',
  'text_assist.tsx',
  'thread_panel.tsx',
  'threads.tsx',
  'timeout_dialog.tsx',
  'typing_indicator.tsx',
  'voice_grid.tsx',
]

// Components that draw people as their account or P2P identity has them, each with the reason.
const AS_THE_ACCOUNT: Record<string, string> = {
  'account_tag.tsx': 'your own accounts and identities',
  'admin/accounts.tsx': 'site administration lists accounts',
  'admin/server_manage.tsx': 'site administration lists accounts',
  'admin/servers.tsx': 'site administration lists accounts',
  'admin/users.tsx': 'site administration lists accounts',
  'avatar_picker.tsx': 'draws the choices of an avatar editor',
  'blocking.tsx': 'blocks are between accounts',
  'display_name.tsx': 'draws the name it is given',
  'forwards.tsx': 'a forward names the author as the place it came from had them',
  'friends.tsx': 'friends are accounts',
  'home.tsx': 'DMs, contacts and your own accounts',
  'invite_card.tsx': 'an invite is shown outside its server',
  'notice_stack.tsx': 'draws the person a notice was built with',
  'notify_settings.tsx': 'names DMs',
  'p2p/add_contact.tsx': 'contacts are identities',
  'p2p/p2p_chat.tsx': 'draws the authors its conversation hands it',
  'p2p/p2p_dm_pane.tsx': 'P2P DMs show contacts',
  'p2p/p2p_home.tsx': 'contacts and your own identity',
  'p2p/p2p_invite_dialog.tsx': 'contacts to invite',
  'p2p/p2p_server_flows.tsx': 'requests from identities, some from outside the server',
  'server_dialogs.tsx': 'names servers',
  'server_rail.tsx': 'names servers and your own account',
  'settings_menu.tsx': 'your own account',
  'share_target.tsx': 'names DMs and servers',
  'user_avatar.tsx': 'draws the picture it is given',
  'webhooks.tsx': 'webhooks keep their own name and picture',
  'webhooks_dialog.tsx': 'webhooks keep their own name and picture',
  'widget_notice.tsx': 'a widget shows a message outside the app',
}

const all = files(components).map(path => ({
  name: relative(components, path),
  text: readFileSync(path, 'utf8'),
}))

test('every component that draws a person says whether a server profile applies', () => {
  const drawing = all.filter(f => draws.test(f.text) || resolves.test(f.text)).map(f => f.name)
  expect(drawing.length).toBeGreaterThan(40)
  const listed = [...IN_A_SERVER, ...Object.keys(AS_THE_ACCOUNT)].sort()
  expect(new Set(listed).size).toBe(listed.length)
  expect(drawing.sort()).toEqual(listed)
})

test('components that draw members or authors of a server resolve them through shownUser', () => {
  const missing = IN_A_SERVER.filter(name => {
    const file = all.find(f => f.name === name)
    return !file || !resolves.test(file.text)
  })
  expect(missing).toEqual([])
})

test('no component reads a look past the shared helpers', () => {
  const direct = all
    .filter(f => /\.profile\?\.(name|avatar_kind|avatar_color)\b/.test(f.text))
    .map(f => f.name)
  expect(direct).toEqual([])
})
