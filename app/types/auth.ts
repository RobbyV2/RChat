export type PasswordMode = 'text' | 'word'
export type ProfileType = 'identicon' | 'person'

export interface AuthFormData {
  username: string
  passwordMode: PasswordMode
  textPassword?: string
  wordSequence?: string[]
  profileType: ProfileType
  avatarColor?: string
}
