import { useParams } from "@solidjs/router"
import { type JSX, Show } from "solid-js"
import { SessionPicker } from "./session-picker"
import { TranscriptView } from "./transcript"
import { UserExtras } from "./user-extras"
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

// Under a user message (the fork line in message-timeline.tsx's user message row): in the Detailed
// view, what the chat hides about that exchange.
export function afterUser(
  message: { id: string; sessionID: string },
  parts: () => ReadonlyArray<{ id: string; type: string; text?: string; synthetic?: boolean }>,
): JSX.Element {
  return <UserExtras message={message} parts={parts} />
}

// At the start of the session's title row (the fork line in message-timeline.tsx): the agent's
// sessions, to open another or start a new one.
export function sessionPicker(
  session: () => { id: string; agent?: string; directory: string; parentID?: string } | undefined,
): JSX.Element {
  return <Show when={session()}>{(info) => <SessionPicker session={info()} />}</Show>
}
