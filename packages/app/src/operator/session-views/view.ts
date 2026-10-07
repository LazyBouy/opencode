import { useNavigate, useSearchParams } from "@solidjs/router"
import { useServer } from "@/context/server"
import { sessionHref } from "@/utils/session-route"
import { useOpenSession } from "../data"

// The full session page's three views: User (OpenCode's chat, unchanged), Transcript (every model call,
// exactly as sent and received) and Detailed (the chat with reasoning, step markers and what the chat
// hides). The view is kept in the URL as `?view=transcript|detailed`; none is User.
export const VIEWS = ["user", "transcript", "detailed"] as const
export type SessionView = (typeof VIEWS)[number]

export function useSessionView() {
  const [params, setParams] = useSearchParams<{ view?: string; call?: string }>()
  const view = (): SessionView => (params.view === "transcript" || params.view === "detailed" ? params.view : "user")
  return {
    view,
    // The call a link points at (Transcript).
    call: () => params.call,
    set: (next: SessionView, call?: string) =>
      setParams({ view: next === "user" ? undefined : next, call: next === "transcript" ? call : undefined }),
    // Picks a call in the Transcript: the address changes without a new history entry.
    select: (call: string | undefined) => setParams({ call }, { replace: true }),
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
