// A value that passed a check carries that in its type: a wire whose schema, sizes, id and
// signature were checked, a certificate or profile whose signature was verified, an admission
// verdict. Only the function that makes the check gives the value this type, and what stores or
// applies such a value takes this type, so a value that skipped its check has nowhere to go.

declare const proven: unique symbol

export type Proven<T, What extends string> = T & { readonly [proven]: What }
