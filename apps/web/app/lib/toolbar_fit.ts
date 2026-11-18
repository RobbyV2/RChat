// How much of a message's hover toolbar sits beside a header's name line, by the row's width in
// px. Each step leaves room for a ten-character name and a time of day: the whole toolbar (up to
// 351 px) from 576, without the quick reactions (up to 242 px) from 464, and below that only
// Add reaction, Reply and More (106 px). The rest stays in the More menu.
export type ToolbarFit = 'full' | 'compact' | 'tight'

export const toolbarFit = (rowWidth: number): ToolbarFit =>
  rowWidth >= 576 ? 'full' : rowWidth >= 464 ? 'compact' : 'tight'

// The action a tight toolbar keeps besides Add reaction and More.
export const keptWhenTight = (key: string) => key === 'reply'
