import type { Action, ActionCtx } from './actions/types'
import type { AccountSession } from './client/session'
import { canUnlink, linkable } from './sso'
import type { RChatState } from './store_types'

export const mayManageSignIns = (s: RChatState) =>
  !!s.me && !s.guest && s.me.password_temporary?.change !== 'required'

export function loadSignInChoices(acct: AccountSession) {
  const state = acct.store.getState()
  if (!mayManageSignIns(state) || !state.instance?.auth?.providers.length) return
  const mark = acct.lifetime.sessionMark(),
    username = state.me!.username
  let live = true
  acct.store.setState({ signInChoices: undefined })
  acct.api
    .ssoLinks()
    .then(links => {
      if (
        live &&
        mark === acct.lifetime.sessionMark() &&
        username === acct.store.getState().me?.username
      )
        acct.store.setState({ signInChoices: { mark, username, links } })
    })
    .catch(() => {
      /* The settings section provides retry and server error details. */
    })
  return () => {
    live = false
  }
}
function choices({ s, mark }: ActionCtx, mode: 'link' | 'unlink') {
  const seen = s.signInChoices,
    auth = s.instance?.auth
  if (!auth || !s.me || !seen || seen.mark !== mark || seen.username !== s.me.username) return []
  const options =
    mode === 'link'
      ? linkable(auth, seen.links)
      : seen.links
          .filter(l => canUnlink(s.me!, seen.links, l.provider))
          .map(l => ({ id: l.provider, name: l.name }))
  return options.map(p => ({ value: p.id, label: p.name }))
}

export const ssoActions: Action[] = (['link', 'unlink'] as const).map(mode => ({
  id: 'sso.' + mode,
  title: mode === 'link' ? 'Link a sign-in' : 'Unlink a sign-in',
  scope: 'global',
  group: 'settings',
  danger: mode === 'unlink',
  available: ({ s }) => mayManageSignIns(s) && !!s.instance?.auth?.providers.length,
  args: [
    {
      kind: 'choice',
      name: 'provider',
      prompt: 'Choose a sign-in provider',
      choices: ctx => choices(ctx, mode),
    },
  ],
  run: (ctx, args) => {
    const p = choices(ctx, mode).find(p => p.value === args.provider)
    if (p)
      ctx.acct.store.getState().openDialog({
        kind: 'settings',
        section: 'profile',
        sso: { type: mode, p: { id: p.value, name: p.label } },
      })
  },
}))

export const signInRowActions: Action[] = [
  {
    id: 'sign_in_unlink',
    title: 'Unlink this sign-in',
    scope: 'global',
    danger: true,
    targets: ['sign_in'],
    available: ({ s, target }) => target.kind === 'sign_in' && mayManageSignIns(s),
    label: ({ target }) => (target.kind === 'sign_in' ? 'Unlink ' + target.name : 'Unlink'),
    disabled: ({ target }) => target.kind === 'sign_in' && !target.allowed,
    run: ({ target }) => {
      if (target.kind === 'sign_in') target.unlink()
    },
  },
]
