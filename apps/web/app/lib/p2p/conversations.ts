import { displayName, requests, visibleContacts, type Contact } from './contacts'

// The P2P conversations a list shows: mutual contacts, newest conversation first, then by the
// name shown. `lastTs` gives the time of a contact's newest message (0 without one).
export const conversations = (contacts: Contact[], lastTs: (ik: string) => number) =>
  visibleContacts(contacts)
    .filter(c => c.state === 'mutual')
    .sort((a, b) => lastTs(b.ik) - lastTs(a.ik) || displayName(a).localeCompare(displayName(b)))

// The P2P part of the instance's DM list: hidden until P2P runs for the account, then its
// conversations and the number of message requests (a row for them only when there are some).
export const p2pDmSection = (st: {
  account: string | null
  enabled: boolean
  contacts: Contact[]
  lastTs: (ik: string) => number
}) =>
  st.account === null || !st.enabled
    ? null
    : { rows: conversations(st.contacts, st.lastTs), requests: requests(st.contacts).length }

// Contacts can be added (and our code shown) only from the tab that runs P2P, once it started.
export const addsContacts = (st: { enabled: boolean; loading: boolean; elsewhere: boolean }) =>
  st.enabled && !st.loading && !st.elsewhere

// The P2P servers stored here are still being read: P2P is starting, or runs in this tab and
// hasn't listed them yet. Not while another tab runs it, nor once it failed.
export const serversLoading = (st: {
  enabled: boolean
  loading: boolean
  countsLoaded: object | null
  elsewhere: boolean
  error: string | null
}) => st.enabled && st.error === null && (st.loading || (st.countsLoaded === null && !st.elsewhere))
