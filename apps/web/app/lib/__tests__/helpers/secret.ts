import { TO_STORE, type Secret } from '../../secret'

// The value inside a secret, for a test to compare.
export const plain = (secret: Secret | null | undefined): string | null =>
  secret ? secret.reveal(TO_STORE) : null
