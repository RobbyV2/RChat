import { RULES_NEXT, RULES_TEXT_ONLY, RULES_VERSION } from './p2p/acl/rules'

// The upgrade of a P2P server to the current rules, as its settings offer it: a new copy its
// owner signs, which members follow.

// Whether a server of these rules has an upgrade to offer.
export const upgradeOffered = (rules: number) => rules < RULES_VERSION

// What a server of these rules gains with the upgrade.
export const upgradeChanges = (rules: number): string[] => [
  ...(rules < RULES_TEXT_ONLY ? ['Text-only channels'] : []),
  ...(rules < RULES_NEXT
    ? [
        'Channel permissions for reactions, files, links, threads, voice and video',
        'Separate permissions for pins, skipping slow mode, giving roles, timeouts and profile resets',
        'Member timeouts and bans that end by themselves',
        'A permission for changing your own server profile',
      ]
    : []),
]

export const UPGRADE_KEEPS =
  'Roles and channel rules keep what they allow today. Members need an updated app to use the new copy.'

export const UPGRADE_CONFIRM =
  'This creates a new copy with the same owner. The old copy becomes read-only and keeps its message history.'

export const UPGRADE_CO_OWNERS =
  'An owner can transfer the server to a member with an updated app. Every co-owner must approve.'
