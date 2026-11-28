import { fromStore, type Load, type LoadMaker, type Pages } from '../../load'
import { searchLoad, type SearchState } from '../../place/search'
import { time } from '../../platform/time'

// A load in the state `pick` says, as a store source makes it.
export const loadOf = <T>(pick: (make: LoadMaker<T>) => Load<T>, retry?: () => void): Load<T> =>
  fromStore<null, T>(
    time(),
    { getState: () => null, subscribe: () => () => {} },
    (_state, make) => pick(make),
    retry ?? null
  ).get()

export const readyLoad = <T>(value: T) => loadOf<T>(make => make.ready(value))

// A list whose first page is here: with `more`, another page can be asked for.
export const pagesOf = <T>(items: T[], more: (() => void) | null = null): Pages<T> => ({
  items,
  more,
  loadingMore: false,
  refusal: null,
})

// The results of a search in the state given, as its place makes them.
export const searchResults = (over: Partial<SearchState> = {}): Load<SearchState> =>
  loadOf<SearchState>(
    make =>
      searchLoad(
        {
          channels: undefined,
          hits: [],
          loading: false,
          hasMore: false,
          pageKey: '0',
          seed: null,
          note: null,
          byIdentity: false,
          failure: null,
          ...over,
        },
        make
      ),
    () => {}
  )
