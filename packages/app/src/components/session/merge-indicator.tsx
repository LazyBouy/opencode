import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { createEffect, createMemo, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { showToast } from "@/utils/toast"
import "./merge-indicator.css"

// Shows that a session is merged with an external agent (`/merge claude`), whose turns stream into
// this session instead of OpenCode's model, and offers copy-id and detach.
export function MergeIndicator(props: { sessionID: string }) {
  const sync = useSync()
  const sdk = useSDK()
  const language = useLanguage()

  createEffect(() => {
    const id = props.sessionID
    if (sync().data.merge[id] === undefined)
      void sync()
        .session.merge(id)
        .catch(() => undefined)
  })

  const binding = createMemo(() => {
    const current = sync().data.merge[props.sessionID]
    return current && (current.status === "live" || current.status === "starting") ? current : undefined
  })

  const fail = (err: unknown) =>
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })

  return (
    <Show when={binding()}>
      {(current) => (
        <div
          data-component="merge-indicator"
          data-status={current().status}
          data-running={current().process ? "" : undefined}
          class="flex items-center"
        >
          <DropdownMenu gutter={4} placement="bottom-end">
            <DropdownMenu.Trigger as={Button} variant="ghost" class="h-[24px] px-2 gap-1.5">
              <span data-slot="merge-indicator-dot" aria-hidden="true" />
              <span class="oc-display text-12-regular truncate max-w-[280px]">
                {language.t("session.merge.indicator", {
                  adapter: current().adapter,
                  id: `${(current().externalSessionID ?? "").slice(0, 4)}…`,
                  status: current().status,
                })}
                {current().process ? ` · ${language.t("session.merge.running")}` : ""}
              </span>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content>
                <DropdownMenu.Item
                  onSelect={() => {
                    const id = current().externalSessionID
                    if (!id) return
                    navigator.clipboard
                      .writeText(id)
                      .then(() =>
                        showToast({
                          variant: "success",
                          icon: "circle-check",
                          title: language.t("session.merge.copied"),
                          description: id,
                        }),
                      )
                      .catch(fail)
                  }}
                >
                  <Icon name="copy" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>
                    {language.t("session.merge.copyId", { adapter: current().adapter })}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  onSelect={() => {
                    void sdk()
                      .client.session.command({ sessionID: props.sessionID, command: "merge", arguments: "detach" })
                      .catch(fail)
                  }}
                >
                  <Icon name="close" size="small" class="text-icon-weak" />
                  <DropdownMenu.ItemLabel>
                    {language.t("session.merge.detach", { adapter: current().adapter })}
                  </DropdownMenu.ItemLabel>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        </div>
      )}
    </Show>
  )
}
