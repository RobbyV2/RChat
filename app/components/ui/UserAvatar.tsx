import { Avatar, Box } from '@mui/material'
import PersonIcon from '@mui/icons-material/Person'

interface UserAvatarProps {
  username: string
  profileType?: string // 'identicon' | 'person' but can be string from DB
  avatarColor?: string | null
  size?: number
}

// Simple hash function for identicon
function simpleHash(str: string) {
  const s = str || ''
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i)
    hash |= 0 // Convert to 32bit integer
  }
  return hash
}

function Identicon({ username, size }: { username: string; size: number }) {
  const hash = simpleHash(username)
  const color = `hsl(${Math.abs(hash) % 360}, 70%, 50%)`

  // 5x5 grid
  const cells: number[] = []
  for (let i = 0; i < 15; i++) {
    // 15 bits needed for 5x3 (mirrored)
    cells.push((hash >> i) & 1)
  }

  return (
    <svg width={size} height={size} viewBox="0 0 5 5" style={{ borderRadius: '50%' }}>
      <rect width="5" height="5" fill="#f0f0f0" />
      {Array.from({ length: 5 }).map((_, y) =>
        Array.from({ length: 5 }).map((_, x) => {
          // Mirror logic: columns 0,1,2 determine 3,4
          const srcX = x < 3 ? x : 4 - x
          const index = y * 3 + srcX
          const filled = cells[index % cells.length] // Reuse bits if needed, or use better hash

          // Use a slightly better distribution logic
          const bit = (hash >> index % 32) & 1

          if (bit) {
            return <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={color} />
          }
          return null
        })
      )}
    </svg>
  )
}

export default function UserAvatar({
  username,
  profileType,
  avatarColor,
  size = 40,
}: UserAvatarProps) {
  const safeUsername = username || 'Anonymous'

  if (profileType === 'person') {
    return (
      <Avatar
        sx={{
          width: size,
          height: size,
          bgcolor: avatarColor || '#3f51b5',
        }}
      >
        <PersonIcon sx={{ fontSize: size * 0.6 }} />
      </Avatar>
    )
  }

  // Default or 'identicon'
  return <Identicon username={safeUsername} size={size} />
}
