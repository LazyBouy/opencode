import { Icon } from "@opencode-ai/ui/icon"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { createMemo, Index, type JSX, onCleanup, onMount, Show } from "solid-js"
import "@/components/settings-v2/settings-v2.css"
import { OverlayControls, OverlayFrame, type Step, useOverlayFrame } from "./overlay-frame"
import "./record-overlay.css"

type IconName = Parameters<typeof Icon>[0]["name"]

export type DetailSection = { id: string; label: string; icon: IconName }

// The overlay a record with sections of its own opens in (an agent: Overview, Prompt, Permissions,
// Sessions), laid out like Settings: the record's sections on the left, one on the right. ‹ › (and
// the arrow keys) move through the page's records, keeping the section; they and the menu are off
// while the record is being edited. `actions` sit in the header, before the controls; `back`, at the
// top of the menu, returns to where the record was chosen ("‹ All projects").
export function DetailOverlay(props: {
  // What the left menu is about (the record's name).
  title: string
  sections: ReadonlyArray<DetailSection>
  section: string
  // The page's records, in order, and the one shown.
  records: ReadonlyArray<string>
  record: string
  editing?: boolean
  actions?: JSX.Element
  back?: { label: string; onClick: () => void }
  onSection: (section: string) => void
  onRecord: (record: string) => void
  children: JSX.Element
}) {
  const index = createMemo(() => props.records.indexOf(props.record))
  const go = (by: number) => {
    const next = props.records[index() + by]
    if (next !== undefined && !props.editing) props.onRecord(next)
  }
  useOverlayKeys(
    () => !props.editing && index() >= 0,
    (by) => go(by),
  )
  const step = (): Step => ({ index: index(), count: props.records.length, go })

  return (
    <OverlayFrame label={props.title} editing={!!props.editing} step={step()}>
      <DetailPanes {...props} step={step()} />
    </OverlayFrame>
  )
}

function DetailPanes(props: Parameters<typeof DetailOverlay>[0] & { step: Step }) {
  const frame = useOverlayFrame()!
  return (
    <TabsV2
      orientation="vertical"
      variant="settings"
      value={props.section}
      onChange={(value: string) => {
        if (!props.editing) props.onSection(value)
      }}
      class="settings-v2"
    >
      <TabsV2.List aria-label={props.title}>
        <div class="flex flex-col gap-1.5 w-full">
          <Show when={props.back}>
            {(back) => (
              <button
                type="button"
                data-slot="record-overlay-back"
                disabled={props.editing}
                onClick={() => back().onClick()}
              >
                <Icon name="chevron-left" size="small" />
                {back().label}
              </button>
            )}
          </Show>
          <TabsV2.SectionTitle>{props.title}</TabsV2.SectionTitle>
          <Index each={props.sections}>
            {(section) => (
              <TabsV2.Trigger value={section().id} disabled={props.editing && section().id !== props.section}>
                <Icon name={section().icon} />
                {section().label}
              </TabsV2.Trigger>
            )}
          </Index>
        </div>
      </TabsV2.List>
      <Index each={props.sections}>
        {(section) => (
          <TabsV2.Content value={section().id} class="settings-v2-panel" data-component="record-overlay-panel">
            <div class="settings-v2-tab-header" data-slot="record-overlay-header">
              <div data-slot="record-overlay-header-row">
                <h2 class="settings-v2-tab-title">{section().label}</h2>
                <span class="flex items-center gap-1">
                  {props.actions}
                  <Show when={!frame.full()}>
                    <OverlayControls step={props.step} editing={!!props.editing} />
                  </Show>
                </span>
              </div>
            </div>
            <div class="settings-v2-tab-body" data-slot="record-overlay-body" tabIndex={-1}>
              <Show when={section().id === props.section}>{props.children}</Show>
            </div>
          </TabsV2.Content>
        )}
      </Index>
    </TabsV2>
  )
}

// ← and → move through a page's records while an overlay is open, unless focus is in a field or a
// menu. Capture: the left menu's tabs would otherwise take the arrow keys first.
export function useOverlayKeys(enabled: () => boolean, go: (by: number) => void) {
  onMount(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (!enabled()) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=listbox], [role=menu]")) return
      event.preventDefault()
      event.stopPropagation()
      go(event.key === "ArrowLeft" ? -1 : 1)
    }
    window.addEventListener("keydown", keys, true)
    onCleanup(() => window.removeEventListener("keydown", keys, true))
  })
}
