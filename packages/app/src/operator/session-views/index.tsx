import { useParams } from "@solidjs/router"
import { type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useChatTrash } from "./chat-trash"
import { SessionMenuItems } from "./session-menu"
import { SessionPicker } from "./session-picker"
import { TranscriptView } from "./transcript"
import { UserExtras } from "./user-extras"
import { useSessionView } from "./view"

export * as OperatorSessionViews from "./index"

// The session page's timeline in the chosen view (the one fork line in pages/session/timeline/
// message-timeline.tsx wraps its render with this): Transcript replaces it with every model call; User
// and Detailed render the timeline (Detailed adds to it through `detailed()`). It also gives the page
// the chat's Move to Trash (`trash()`).
export function timeline(render: () => JSX.Element): JSX.Element {
  const view = useSessionView()
  const params = useParams<{ id?: string }>()
  useChatTrash()
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

// The fork's items in the chat's "…" menu (one fork line in each of message-timeline.tsx's menus,
// before the separator): Session permissions.
export function menuItems(sessionID: string, kind: "v1" | "v2"): JSX.Element {
  return <SessionMenuItems sessionID={sessionID} kind={kind} />
}

// The chat's "…" → Move to Trash… instead of Delete… (one fork call in each of message-timeline.tsx's
// two menus): `trash(id)` asks and moves the session, with its subagents' sessions, to Trash; it is
// undefined (so upstream's Delete runs) when no session page registered the handler.
export { trash } from "./chat-trash"
export function trashLabel(): string | undefined {
  return useLanguage().t("operator.chatTrash.menu")
}
