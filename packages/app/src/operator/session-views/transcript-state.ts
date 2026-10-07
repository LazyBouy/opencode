import { createContext, createEffect, onCleanup, useContext } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"

// The Transcript's view state, per session, kept in sessionStorage so it lasts while switching to the
// User or Detailed view and back, while the list refreshes, and across a reload: which sections are
// open, the filter, search and toggles, which turns are folded, which items, groups, cards and raw
// panels are open, the selection, and the scroll positions.

export type Section = "summary" | "input" | "calls"
export type Filter = "all" | "agent" | "side" | "errors"

export type TranscriptState = {
  v: 1
  sections: Record<Section, boolean>
  filter: Filter
  search: string
  onlyNew: boolean
  expanded: boolean
  // Turns folded, by turn index.
  folded: Record<string, boolean>
  // Everything else that opens: `item:<call>:<item>`, `group:<call>:<key>`, `raw:<call>:<part>`, …
  open: Record<string, boolean>
  // What Call details shows: "all", "turn:<n>" or "call:<id>"; none: the latest turn.
  selection?: string
  scroll: { page: number; list: number }
}

const fresh = (): TranscriptState => ({
  v: 1,
  sections: { summary: true, input: true, calls: true },
  filter: "all",
  search: "",
  onlyNew: false,
  expanded: false,
  folded: {},
  open: {},
  scroll: { page: 0, list: 0 },
})

const keyOf = (sessionID: string) => `operator.transcript:${sessionID}`

function read(sessionID: string): TranscriptState {
  try {
    const value = JSON.parse(sessionStorage.getItem(keyOf(sessionID)) ?? "null") as Partial<TranscriptState> | null
    if (!value || value.v !== 1) return fresh()
    const base = fresh()
    return {
      ...base,
      ...value,
      sections: { ...base.sections, ...value.sections },
      scroll: { ...base.scroll, ...value.scroll },
    }
  } catch {
    return fresh()
  }
}

export function createTranscriptState(sessionID: string) {
  const [state, setState] = createStore<TranscriptState>(read(sessionID))
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: string | undefined
  const write = () => {
    clearTimeout(timer)
    if (pending === undefined) return
    try {
      sessionStorage.setItem(keyOf(sessionID), pending)
    } catch {
      // kept for this page only
    }
    pending = undefined
  }
  createEffect(() => {
    pending = JSON.stringify(state)
    clearTimeout(timer)
    timer = setTimeout(write, 200)
  })
  // Leaving the view (User, Detailed, another session) or the page saves what is pending at once.
  onCleanup(write)
  window.addEventListener("pagehide", write)
  onCleanup(() => window.removeEventListener("pagehide", write))
  return [state, setState] as const
}

const Context = createContext<{ state: TranscriptState; setState: SetStoreFunction<TranscriptState> }>()
export const TranscriptStateProvider = Context.Provider

export function useTranscriptState() {
  return useContext(Context)
}

// One thing that opens and closes, kept in the state (a plain signal outside a Transcript).
export function useOpen(key: () => string): [() => boolean, (open: boolean) => void] {
  const context = useTranscriptState()
  const [local, setLocal] = createStore({ open: false })
  if (!context) return [() => local.open, (open) => setLocal("open", open)]
  return [() => !!context.state.open[key()], (open) => context.setState("open", key(), open)]
}
