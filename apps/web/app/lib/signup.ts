import { ApiError } from './api'

// Where the sign-up form shows a refused sign-up: under the username field, or in the form's
// own error line. A sign-up sends a username, a password or words, and an avatar, so a 400
// that names none of the others is about the username (the name filter says only "Content
// blocked").
export type SignupField = 'username' | 'form'

export interface SignupFailure {
  field: SignupField
  message: string
}

const NAMES = /\busernames?\b/i
const OTHER = /\b(passwords?|words?|avatar|colou?r)\b/i

export const signupField = (status: number, message: string): SignupField =>
  status === 400 && (NAMES.test(message) || !OTHER.test(message)) ? 'username' : 'form'

export const signupFailure = (e: unknown): SignupFailure => {
  const message = e instanceof Error ? e.message : String(e)
  return { field: e instanceof ApiError ? signupField(e.status, message) : 'form', message }
}
