// The icon a member's role puts after their name: one emoji at 16 px, named for the role.
export function RoleIcon({ emoji, role }: { emoji?: string; role?: string }) {
  if (!emoji || role === undefined) return null
  return (
    <span
      role="img"
      title={role}
      aria-label={role}
      data-role-icon
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center self-center text-[14px] leading-4"
    >
      {emoji}
    </span>
  )
}
