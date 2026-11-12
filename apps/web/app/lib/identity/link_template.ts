export type LinkInput = {
  issuer: string
  clientId: string
  redirect: string
  scopes: string[]
  joinServers: string[]
  initiateLoginUri: string | null
}

export const JOIN_SERVERS_MAX = 5

export const linkTemplate = (i: LinkInput) => {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: i.clientId,
    redirect_uri: i.redirect,
    scope: [...new Set(['openid', 'profile', ...i.scopes])].join(' '),
  })
  if (i.joinServers.length)
    q.set('join_servers', i.joinServers.slice(0, JOIN_SERVERS_MAX).join(','))
  return {
    template: `${i.issuer}/oauth/authorize?${q.toString()}&state={state}&code_challenge={code_challenge}&code_challenge_method=S256`,
    share: i.initiateLoginUri ? `${i.initiateLoginUri}?iss=${encodeURIComponent(i.issuer)}` : null,
  }
}

export const placeholdersLeft = (url: string) => /\{state\}|\{code_challenge\}/.test(url)

export const fillTemplate = (template: string, state: string, codeChallenge: string) =>
  template
    .replace('{state}', encodeURIComponent(state))
    .replace('{code_challenge}', encodeURIComponent(codeChallenge))
