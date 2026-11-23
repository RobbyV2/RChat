import { addAccount, addInstance, parseBook } from '../client/book'
import { client } from '../client/client'
import { instanceDescriptor } from '../client/credentials'

// Legacy fixtures exercise the initial page connection.
export const home = client.homeInstance()
export const api = home.api

// Route tests set `me` directly, bypassing the login that records the primary account.
export function installPrimaryAccount(username: string) {
  const previous = client.book.getState()
  const raw = localStorage.getItem('rchat_book')
  const book = addAccount(
    addInstance(parseBook(null), instanceDescriptor(home)),
    home.origin,
    { username, display: null, avatar: null, identities: [], added: 0, connect: true },
    home.origin
  )
  localStorage.setItem('rchat_book', JSON.stringify(book))
  client.book.setState(book, true)
  return () => {
    if (raw === null) localStorage.removeItem('rchat_book')
    else localStorage.setItem('rchat_book', raw)
    client.book.setState(previous, true)
  }
}
