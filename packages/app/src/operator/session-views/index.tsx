import { useParams } from "@solidjs/router"
import { type JSX, Show } from "solid-js"
import { TranscriptView } from "./transcript"
import { useSessionView } from "./view"

export * as OperatorSessionViews from "./index"

// The session page's timeline in the chosen view (the one fork line in pages/session/timeline/
// message-timeline.tsx wraps its render with this): Transcript replaces it with every model call; User
// and Detailed render the timeline (Detailed adds to it through `detailed()`).
export function timeline(render: () => JSX.Element): JSX.Element {
  const view = useSessionView()
  const params = useParams<{ id?: string }>()
  return (
    <Show when={view.view() === "transcript" && params.id} fallback={render()}>
      {(id) => <TranscriptView sessionID={id()} />}
    </Show>
  )
}

// Whether the session page shows the Detailed view.
export function useDetailed() {
  const view = useSessionView()
  return () => view.view() === "detailed"
}
