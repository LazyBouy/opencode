import { useNavigate, useSearchParams } from "@solidjs/router"
import { useServer } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { useOpenSession } from "../data"

// The full session page's three views: User (OpenCode's chat, unchanged), Detailed (the chat with
// reasoning, step markers and what the chat hides) and Transcript (every model call, exactly as sent and
// received; read-only). The view is kept in the URL as `?view=detailed|transcript`; none is User.
export const VIEWS = ["user", "detailed", "transcript"] as const
export type SessionView = (typeof VIEWS)[number]

export function useSessionView() {
  const [params, setParams] = useSearchParams<{ view?: string; call?: string; turn?: string }>()
  const view = (): SessionView => (params.view === "transcript" || params.view === "detailed" ? params.view : "user")
  return {
    view,
    // The call a link points at (Transcript).
    call: () => params.call,
    set: (next: SessionView, call?: string) =>
      setParams({
        view: next === "user" ? undefined : next,
        call: next === "transcript" ? call : undefined,
        turn: undefined,
      }),
    // The turn the Transcript shows ("all", or a turn's number).
    turn: () => params.turn,
    // Picks a call, a turn or all turns in the Transcript: the address changes without a new history
    // entry.
    select: (call: string | undefined) => setParams({ call, turn: undefined }, { replace: true }),
    selectTurn: (turn: string | undefined) => setParams({ turn, call: undefined }, { replace: true }),
  }
}

// Opens a session's full page in a view.
export function useOpenSessionView() {
  const openSession = useOpenSession()
  const navigate = useNavigate()
  const server = useServer()
  return (sessionID: string, view: SessionView, call?: string) => {
    openSession(sessionID)
    if (view === "user") return
    const query = new URLSearchParams({ view, ...(call ? { call } : {}) })
    navigate(`${sessionHref(server.key, sessionID)}?${query.toString()}`, { replace: true })
  }
}
