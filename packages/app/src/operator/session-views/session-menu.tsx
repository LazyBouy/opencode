import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Dialog, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { useQuery } from "@tanstack/solid-query"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { ready, useOperatorClient } from "../data"
import { SessionPermissions } from "../ui/session-permissions"

// The fork's items in the chat's "…" menu (one fork line in each of message-timeline.tsx's two
// menus): Session permissions, which opens the session's permission editor in a dialog.
export function SessionMenuItems(props: { sessionID: string; kind: "v1" | "v2" }) {
  const language = useLanguage()
  const dialog = useDialog()
  const open = () => void dialog.show(() => <SessionPermissionsDialog sessionID={props.sessionID} />)
  return (
    <Show
      when={props.kind === "v2"}
      fallback={
        <DropdownMenu.Item onSelect={open}>
          <DropdownMenu.ItemLabel>{language.t("operator.sessionMenu.permissions")}</DropdownMenu.ItemLabel>
        </DropdownMenu.Item>
      }
    >
      <MenuV2.Item onSelect={open}>{language.t("operator.sessionMenu.permissions")}...</MenuV2.Item>
    </Show>
  )
}

function SessionPermissionsDialog(props: { sessionID: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const session = useQuery(() => ({
    queryKey: api.key("session", props.sessionID),
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: props.sessionID })
        .then((result) => result.data!),
  }))
  return (
    <Dialog size="x-large" variant="settings" class="record-overlay">
      <DialogHeader>
        <DialogTitle>{language.t("operator.sessionMenu.permissions")}</DialogTitle>
      </DialogHeader>
      <div
        class="settings-v2-tab-body"
        style={{ padding: "0 24px 24px", overflow: "auto" }}
        data-testid="session-menu-permissions"
      >
        <Show when={ready(session)}>
          {(info) => <SessionPermissions sessionID={props.sessionID} directory={info().directory} />}
        </Show>
      </div>
    </Dialog>
  )
}
