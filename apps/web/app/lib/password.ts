export type PassKind = 'text' | 'words'

export interface Secret {
  password?: string
  words?: string[]
}

export interface PasswordForm {
  currentKind: PassKind
  current: string
  currentWords: string[]
  newKind: PassKind
  next: string
  confirm: string
  newWords: string[]
}

export const secretOf = (kind: PassKind, password: string, words: string[]): Secret =>
  kind === 'text' ? { password } : { words }

export function passwordChangeError(f: PasswordForm): string | null {
  if (f.currentKind === 'text' && !f.current) return 'Enter your current password'
  if (f.currentKind === 'words' && f.currentWords.length !== 7)
    return 'Pick your current 7 words in order'
  if (f.newKind === 'words') return f.newWords.length === 7 ? null : 'Pick 7 new words in order'
  if (!f.next) return 'Enter a new password'
  if (f.next !== f.confirm) return "New passwords don't match"
  return null
}
