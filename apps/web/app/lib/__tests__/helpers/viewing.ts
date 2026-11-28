import type { createViewing } from '../../viewing'

type Viewing = Pick<ReturnType<typeof createViewing>, 'registerPromptHost' | 'useViewing'>
type Prompt = NonNullable<ReturnType<Viewing['useViewing']['getState']>['prompt']>

// Answers a viewing prompt as the prompt's screen would: the open one, or `of`.
export const answerPrompt = (
  viewing: Viewing,
  open: boolean,
  remember = false,
  of: Prompt | null = viewing.useViewing.getState().prompt
) => {
  const host = viewing.registerPromptHost()
  if (!host) throw new Error('the prompt already has a host')
  try {
    if (of) host.answer(of, open, remember)
  } finally {
    host.release()
  }
}
