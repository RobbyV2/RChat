import { describe, expect, test } from 'bun:test'
import { passwordChangeError, secretOf, type PasswordForm } from '../password'

const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

const form = (over: Partial<PasswordForm>): PasswordForm => ({
  currentKind: 'text',
  current: 'old',
  currentWords: [],
  newKind: 'text',
  next: 'new',
  confirm: 'new',
  newWords: [],
  ...over,
})

describe('secretOf', () => {
  test('text sends only the password', () => {
    expect(secretOf('text', 'pw', seven)).toEqual({ password: 'pw' })
  })

  test('words sends only the words', () => {
    expect(secretOf('words', 'pw', seven)).toEqual({ words: seven })
  })
})

describe('passwordChangeError', () => {
  test('valid text to text', () => {
    expect(passwordChangeError(form({}))).toBeNull()
  })

  test('current is required in its kind', () => {
    expect(passwordChangeError(form({ current: '' }))).toBe('Enter your current password')
    expect(passwordChangeError(form({ currentKind: 'words', currentWords: seven.slice(1) }))).toBe(
      'Pick your current 7 words in order'
    )
    expect(passwordChangeError(form({ currentKind: 'words', currentWords: seven }))).toBeNull()
  })

  test('new text must be non-empty and confirmed', () => {
    expect(passwordChangeError(form({ next: '', confirm: '' }))).toBe('Enter a new password')
    expect(passwordChangeError(form({ confirm: 'other' }))).toBe("New passwords don't match")
    expect(passwordChangeError(form({ next: ' ', confirm: ' ' }))).toBeNull()
  })

  test('new words need exactly 7 and ignore the text fields', () => {
    expect(passwordChangeError(form({ newKind: 'words', newWords: seven.slice(2) }))).toBe(
      'Pick 7 new words in order'
    )
    expect(
      passwordChangeError(form({ newKind: 'words', newWords: seven, next: '', confirm: 'x' }))
    ).toBeNull()
  })
})
