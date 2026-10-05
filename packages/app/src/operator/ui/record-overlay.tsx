import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { createEffect, createMemo, For, Index, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js"
import "@/components/settings-v2/settings-v2.css"
import { useLanguage } from "@/context/language"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { FieldHelp } from "./field-help"
import { NamespaceAction } from "./namespace-picker"
import "./record-overlay.css"

type IconName = Parameters<typeof Icon>[0]["name"]

export type OverlayRecord = { id: string; label: JSX.Element; detail?: JSX.Element }

// One block of a page (a section of Layer Definition, Group types, …): a left-menu item in the
// overlay, with its records.
export type OverlayBlock = {
  id: string
  label: string
  icon: IconName
  description?: JSX.Element
  records: ReadonlyArray<OverlayRecord>
  empty?: string
  // New record: in `ns`, or (no namespace, all of them shown) in the one chosen from a menu.
  create?: { label: string; ns: string | undefined; run: (ns: string) => void }
}

// The overlay a page's records open in, laid out like Settings: the page's blocks on the left; on
// the right a block's records, or one record. ‹ › (and the arrow keys) move through every record on
// the page; they and the menu are off while the record is being edited. The record's view is
// `children`, shown when `record` is set.
export function RecordOverlay(props: {
  title: string
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  blocks: ReadonlyArray<OverlayBlock>
  block: string
  record?: string
  editing: boolean
  onBlock: (block: string) => void
  onRecord: (block: string, record: string) => void
  children: JSX.Element
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const all = createMemo(() =>
    props.blocks.flatMap((block) => block.records.map((record) => ({ block: block.id, id: record.id }))),
  )
  const index = createMemo(() =>
    props.record ? all().findIndex((item) => item.block === props.block && item.id === props.record) : -1,
  )
  const go = (by: number) => {
    const next = all()[index() + by]
    if (next && !props.editing) props.onRecord(next.block, next.id)
  }

  // Moving to another block replaces its pane, and the focused button with it: keep focus in the
  // overlay (on the new pane) so the keyboard keeps working.
  createEffect(
    on(
      () => [props.block, props.record],
      () =>
        requestAnimationFrame(() => {
          const active = document.activeElement
          if (active && active !== document.body && active.isConnected) return
          document
            .querySelector<HTMLElement>('[data-component="record-overlay-panel"] [data-slot="record-overlay-body"]')
            ?.focus({ preventScroll: true })
        }),
      { defer: true },
    ),
  )

  onMount(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      if (props.editing || index() < 0) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=listbox], [role=menu]")) return
      event.preventDefault()
      event.stopPropagation()
      go(event.key === "ArrowLeft" ? -1 : 1)
    }
    // Capture: the left menu's tabs would otherwise take the arrow keys first.
    window.addEventListener("keydown", keys, true)
    onCleanup(() => window.removeEventListener("keydown", keys, true))
  })

  return (
    <Dialog size="x-large" variant="settings" class="record-overlay">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={props.block}
        onChange={(value: string) => {
          if (!props.editing) props.onBlock(value)
        }}
        class="settings-v2"
      >
        <TabsV2.List aria-label={props.title}>
          <div class="flex flex-col gap-1.5 w-full">
            <TabsV2.SectionTitle>{props.title}</TabsV2.SectionTitle>
            <Index each={props.blocks}>
              {(block) => (
                <TabsV2.Trigger value={block().id} disabled={props.editing && block().id !== props.block}>
                  <Icon name={block().icon} />
                  {block().label}
                </TabsV2.Trigger>
              )}
            </Index>
          </div>
        </TabsV2.List>
        {/* Blocks are rebuilt whenever the catalog refreshes; Index keeps the panes, and an open edit. */}
        <Index each={props.blocks}>
          {(block) => (
            <TabsV2.Content value={block().id} class="settings-v2-panel" data-component="record-overlay-panel">
              <div class="settings-v2-tab-header" data-slot="record-overlay-header">
                <div data-slot="record-overlay-header-row">
                  <h2 class="settings-v2-tab-title">{block().label}</h2>
                  <span class="flex items-center gap-1">
                    <Show when={index() >= 0}>
                      <IconButtonV2
                        variant="ghost-muted"
                        size="small"
                        icon={<Icon name="chevron-left" />}
                        aria-label={language.t("operator.overlay.previous")}
                        disabled={props.editing || index() <= 0}
                        onClick={() => go(-1)}
                      />
                      <span data-slot="record-overlay-position">
                        {language.t("operator.overlay.position", { index: index() + 1, count: all().length })}
                      </span>
                      <IconButtonV2
                        variant="ghost-muted"
                        size="small"
                        icon={<Icon name="chevron-right" />}
                        aria-label={language.t("operator.overlay.next")}
                        disabled={props.editing || index() >= all().length - 1}
                        onClick={() => go(1)}
                      />
                    </Show>
                    <IconButtonV2
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="close" />}
                      aria-label={language.t("operator.overlay.close")}
                      onClick={() => dialog.close()}
                    />
                  </span>
                </div>
              </div>
              <div class="settings-v2-tab-body" data-slot="record-overlay-body" tabIndex={-1}>
                <Show
                  when={props.record}
                  fallback={
                    <BlockList
                      block={block()}
                      namespaces={props.namespaces}
                      onOpen={(id) => props.onRecord(block().id, id)}
                    />
                  }
                >
                  {props.children}
                </Show>
              </div>
            </TabsV2.Content>
          )}
        </Index>
      </TabsV2>
    </Dialog>
  )
}

// A block's records, as a list to open one from.
function BlockList(props: {
  block: OverlayBlock
  namespaces: ReadonlyArray<OperatorNamespaceSummary>
  onOpen: (id: string) => void
}) {
  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <Show when={props.block.description}>
          <p data-slot="operator-note">{props.block.description}</p>
        </Show>
        <Show when={props.block.create}>
          {(create) => (
            <span class="shrink-0">
              <NamespaceAction
                size="small"
                label={create().label}
                ns={create().ns}
                namespaces={props.namespaces}
                run={create().run}
              />
            </span>
          )}
        </Show>
      </div>
      <Show when={props.block.records.length} fallback={<p data-slot="operator-note">{props.block.empty}</p>}>
        <ul data-component="record-overlay-list" aria-label={props.block.label}>
          <For each={props.block.records}>
            {(record) => (
              <li>
                <button type="button" data-slot="record-overlay-item" onClick={() => props.onOpen(record.id)}>
                  <span data-slot="record-overlay-item-label">{record.label}</span>
                  <Show when={record.detail}>
                    <span data-slot="record-overlay-item-detail">{record.detail}</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

// A record's view: title (with tags), actions, then its content.
export function RecordView(props: { title: JSX.Element; actions?: JSX.Element; children: JSX.Element }) {
  return (
    <section data-component="record-view">
      <div data-slot="record-view-head">
        <h3 data-slot="record-view-title">{props.title}</h3>
        <Show when={props.actions}>
          <div data-slot="record-view-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </section>
  )
}

// A read-only field of a record: its label with the field helper's (i), and its value.
export function RecordField(props: { label: string; help: JSX.Element; children: JSX.Element }) {
  return (
    <>
      <dt>
        {props.label}
        <FieldHelp field={props.label} text={props.help} />
      </dt>
      <dd>{props.children}</dd>
    </>
  )
}

// Opens the overlay while `wanted` is true (a record or block chosen in the URL), and calls
// `onClose` when it closes, so the page can clear its URL state.
export function useRecordOverlay(wanted: () => boolean, render: () => JSX.Element, onClose: () => void) {
  const dialog = useDialog()
  let shown = false
  createEffect(() => {
    if (!wanted() || shown) return
    shown = true
    untrack(() =>
      dialog.show(render, () => {
        shown = false
        onClose()
      }),
    )
  })
  onCleanup(() => {
    if (shown) dialog.close()
  })
}
