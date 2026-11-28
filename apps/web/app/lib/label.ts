// Text for a label, a tooltip, a placeholder or an option, as the viewer may read it. A written
// string is not one: a label is the app's own words as written, a line made by the functions
// below, or a name's label from `lib/names.ts`, which applies streamer mode and the viewer's filter.

declare const spoken: unique symbol

export type Label = string & { readonly [spoken]: true }

// The app's own words, written out where they are used: a string literal (or a choice between
// literals) and nothing computed.
export type Words<L extends string> = string extends L
  ? never
  : // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    {} extends Record<L, 1>
    ? never
    : L

// What a control takes for its label, tooltip or placeholder: the app's own words or a label.
export type Said<L extends string> = Label | Words<L>

// The app's own words as a label, where one is kept in a value ("a contact", a menu's entry).
export const unnamed = <const L extends string>(words: Said<L>): Label => words as string as Label

// Text that is nobody's name and that streamer mode does not hide: a file's name, an error's
// line, a key, an emoji, words an app or a setting supplies.
export const notAName = (text: string): Label => text as Label

// A line around name labels: labelWith`Message ${label}`. Only labels and counts go in.
export const labelWith = (
  words: TemplateStringsArray,
  ...parts: readonly (Label | number)[]
): Label => words.reduce((line, word, i) => line + String(parts[i - 1]) + word) as Label

export const labelList = (labels: readonly Label[], between = ', '): Label =>
  labels.join(between) as Label
