// A channel's restrictions and its allow list, as the instance and P2P settings show them.
// `nobody`: who still can when the list is empty ("admins").

export type RestrictKey = 'restrict_view' | 'restrict_send'

export const restrictionItems = (nobody: string) =>
  [
    {
      key: 'restrict_view',
      label: 'Require roles to view',
      detail: `Only the roles and members below can see this channel. Leave empty for ${nobody} only.`,
    },
    {
      key: 'restrict_send',
      label: 'Require roles to send',
      detail: `Only the roles and members below can send. Leave empty for ${nobody} only.`,
    },
  ] as const

export const allowListTitle = (restricted: boolean) =>
  restricted ? 'Allowed roles and members' : 'Role and member overrides'

export const emptyAllowText = (view: boolean, send: boolean, nobody: string) =>
  view
    ? `Nobody added. Only ${nobody} can see this channel.`
    : send
      ? `Nobody added. Only ${nobody} can send.`
      : 'No overrides. The channel is open to everyone.'
