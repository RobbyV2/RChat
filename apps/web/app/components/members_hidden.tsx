'use client'
import { Users } from 'lucide-react'
import { MEMBERS_HIDDEN_LINE, MEMBERS_HIDDEN_TITLE, type MembersHidden } from '../lib/member_list'
import { Stack, Surface } from './layout'

// What a member list panel shows in place of the members it may not show, and why.
export function MembersHiddenState({ why }: { why: MembersHidden }) {
  return (
    <Surface pad="xl" tone="plain" radius="none" place="h-full">
      <Stack
        gap="xs"
        align="center"
        justify="center"
        place="h-full"
        role="status"
        data-members-hidden={why}
      >
        <Users size={40} className="text-on-surface-variant/70" aria-hidden />
        <p className="text-center text-base font-semibold text-on-surface">
          {MEMBERS_HIDDEN_TITLE}
        </p>
        <p className="text-center text-sm text-on-surface-variant">{MEMBERS_HIDDEN_LINE[why]}</p>
      </Stack>
    </Surface>
  )
}
