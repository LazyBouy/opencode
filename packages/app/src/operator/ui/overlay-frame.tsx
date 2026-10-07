import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useSearchParams } from "@solidjs/router"
import { createContext, createEffect, createSignal, For, type JSX, onCleanup, Show, useContext } from "solid-js"
import { useLanguage } from "@/context/language"
import { operatorPages } from "../pages"
import { registerFrame, useGoTo, useRecordLabel, useTrail } from "./overlay-nav"
import { shown } from "./trail"
import "./record-overlay.css"

// The frame every record overlay opens in (RecordOverlay, DetailOverlay): the dialog, and Full screen
// (fixes_spec.md §1). Full screen is `full=1` on the page's own address: the same dialog takes the
// whole window below the title bar, its menu replacing the sidebar, with the back path, ‹ Back, ‹ ›,
// Exit full screen and Close above it. Nothing remounts, so an open edit stays.

export type Step = { index: number; count: number; go: (by: number) => void }

type Frame = { full: () => boolean; setFull: (on: boolean) => void; close: () => void }
const FrameContext = createContext<Frame>()

// The open overlay's Full screen and Close (for records that close themselves, such as after a delete).
export function useOverlayFrame() {
  return useContext(FrameContext)
}

export function OverlayFrame(props: {
  // The record (or block) shown, for the back path.
  label: string | undefined
  editing: boolean
  step?: Step
  children: JSX.Element
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [params, setParams] = useSearchParams<{ full?: string }>()
  const full = () => params.full === "1"
  const setFull = (on: boolean) => setParams({ full: on ? "1" : undefined }, { replace: true })
  const [closing, setClosing] = createSignal(false)
  let element: HTMLDivElement | undefined
  // "Discard your changes?", asked inside the overlay (a second dialog stacked on it could outlive its
  // closing and keep the overlay from closing).
  const [question, setQuestion] = createSignal<(ok: boolean) => void>()
  const ask = () =>
    new Promise<boolean>((resolve) => {
      question()?.(false)
      setQuestion(() => (ok: boolean) => {
        setQuestion(undefined)
        resolve(ok)
      })
    })
  // The dialog closes the one on top, and not while another is still closing (a question just
  // answered): try again until this one has closed, while it is the one on top.
  const onTop = () => {
    const layers = document.querySelectorAll("[data-dialog-layer]")
    return !!element && !!layers[layers.length - 1]?.contains(element)
  }
  // Close: while editing, only after asking.
  const close = () => {
    const go = (tries = 0) => {
      if (!element?.isConnected || tries > 20) return
      setClosing(true)
      if (onTop()) dialog.close()
      setTimeout(() => go(tries + 1), 150)
    }
    if (!props.editing) return go()
    void ask().then((ok) => ok && go())
  }
  registerFrame({
    element: () => element,
    full,
    exitFull: () => setFull(false),
    editing: () => props.editing && !closing(),
    close,
    ask,
    asking: () => !!question(),
    answer: (ok) => question()?.(ok),
  })
  useRecordLabel(() => props.label)

  // Full screen starts below the title bar (or ends above it, when the title bar is at the bottom).
  createEffect(() => {
    if (!full()) return
    const bar = document.getElementById("opencode-titlebar-right")?.closest("header")?.getBoundingClientRect()
    const root = document.documentElement.style
    const atTop = !bar || bar.top < window.innerHeight / 2
    root.setProperty("--operator-full-top", atTop && bar ? `${bar.bottom}px` : "0px")
    root.setProperty("--operator-full-bottom", !atTop && bar ? `${window.innerHeight - bar.top}px` : "0px")
    onCleanup(() => {
      root.removeProperty("--operator-full-top")
      root.removeProperty("--operator-full-bottom")
    })
  })

  return (
    <FrameContext.Provider value={{ full, setFull, close }}>
      <Dialog
        size="x-large"
        variant="settings"
        class="record-overlay"
        containerClass={full() ? "operator-overlay-full" : undefined}
      >
        <div
          ref={element}
          data-component="operator-overlay-frame"
          data-full={full() ? "" : undefined}
          data-testid="overlay-frame"
        >
          <Show when={full()}>
            <div data-slot="operator-overlay-topbar" data-testid="overlay-topbar">
              <TrailView />
              <span data-slot="operator-overlay-topbar-controls">
                <OverlayControls step={props.step} editing={props.editing} />
              </span>
            </div>
          </Show>
          {props.children}
          <Show when={question()}>
            {(answer) => (
              <div data-slot="operator-overlay-question" data-testid="overlay-question">
                <div
                  data-slot="operator-overlay-question-box"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="operator-overlay-question-title"
                >
                  <strong id="operator-overlay-question-title">{language.t("operator.overlay.discardTitle")}</strong>
                  <p data-slot="operator-note">{language.t("operator.overlay.discardBody")}</p>
                  <div data-slot="operator-actions">
                    <ButtonV2 variant="neutral" onClick={() => answer()(false)}>
                      {language.t("common.cancel")}
                    </ButtonV2>
                    <ButtonV2 variant="danger" autofocus onClick={() => answer()(true)}>
                      {language.t("operator.overlay.discard")}
                    </ButtonV2>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Dialog>
    </FrameContext.Provider>
  )
}

// ‹ position ›, Full screen (or Exit full screen) and Close: in the overlay's header, or in full
// screen's top bar. ‹ › and the full screen switch are off while the record is being edited.
export function OverlayControls(props: { step?: Step; editing: boolean }) {
  const language = useLanguage()
  const frame = useOverlayFrame()!
  const step = () => props.step
  return (
    <span class="flex items-center gap-1" data-slot="operator-overlay-controls">
      <Show when={step() && step()!.index >= 0}>
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          icon={<Icon name="chevron-left" />}
          aria-label={language.t("operator.overlay.previous")}
          disabled={props.editing || step()!.index <= 0}
          onClick={() => step()!.go(-1)}
        />
        <span data-slot="record-overlay-position">
          {language.t("operator.overlay.position", { index: step()!.index + 1, count: step()!.count })}
        </span>
        <IconButtonV2
          variant="ghost-muted"
          size="small"
          icon={<Icon name="chevron-right" />}
          aria-label={language.t("operator.overlay.next")}
          disabled={props.editing || step()!.index >= step()!.count - 1}
          onClick={() => step()!.go(1)}
        />
      </Show>
      <Show
        when={frame.full()}
        fallback={
          <IconButtonV2
            variant="ghost-muted"
            size="small"
            icon={<Icon name="expand" />}
            aria-label={language.t("operator.overlay.fullScreen")}
            title={language.t("operator.overlay.fullScreen")}
            data-action="overlay-full-screen"
            onClick={() => frame.setFull(true)}
          />
        }
      >
        <ButtonV2
          size="small"
          variant="ghost"
          data-action="overlay-exit-full-screen"
          onClick={() => frame.setFull(false)}
        >
          <Icon name="collapse" size="small" />
          {language.t("operator.overlay.exitFullScreen")}
        </ButtonV2>
      </Show>
      <IconButtonV2
        variant="ghost-muted"
        size="small"
        icon={<Icon name="close" />}
        aria-label={language.t("operator.overlay.close")}
        onClick={() => frame.close()}
      />
    </span>
  )
}

// The back path: ‹ Back, then "Dashboard › … › Projects › opencode"; a long trail keeps its middle in
// a menu. A crumb goes back through the history to it, as the browser's Back does.
function TrailView() {
  const language = useLanguage()
  const trail = useTrail()
  const goTo = useGoTo()
  const view = () => shown(trail())
  const previous = () => trail().at(-2)
  // A crumb whose page did not say its name before it was left: the page's title, else its address.
  const labelOf = (item: ReturnType<typeof trail>[number]) => {
    if (item.label) return item.label
    const path = item.url.split("?")[0]
    const page = operatorPages.find((entry) => entry.path === path)
    return page ? language.t(`operator.page.${page.id}.title` as Parameters<typeof language.t>[0]) : item.url
  }
  const Crumb = (crumb: { item: ReturnType<typeof trail>[number]; last: boolean }) => (
    <Show
      when={!crumb.last}
      fallback={
        <span data-slot="operator-trail-current" aria-current="page">
          {labelOf(crumb.item)}
        </span>
      }
    >
      <button type="button" data-slot="operator-trail-crumb" onClick={() => goTo(crumb.item)}>
        {labelOf(crumb.item)}
      </button>
    </Show>
  )
  const isLast = (item: ReturnType<typeof trail>[number]) => item === trail().at(-1)
  return (
    <nav data-component="operator-trail" aria-label={language.t("operator.overlay.trail")} data-testid="overlay-trail">
      <ButtonV2
        size="small"
        variant="ghost"
        disabled={!previous()}
        data-action="overlay-back"
        onClick={() => previous() && goTo(previous()!)}
      >
        <Icon name="chevron-left" size="small" />
        {language.t("operator.overlay.back")}
      </ButtonV2>
      <For each={view().first}>
        {(item, at) => (
          <>
            <Show when={at() > 0}>
              <span data-slot="operator-trail-separator">{" › "}</span>
            </Show>
            <Crumb item={item} last={isLast(item)} />
          </>
        )}
      </For>
      <Show when={view().hidden.length}>
        <span data-slot="operator-trail-separator">{" › "}</span>
        <MenuV2 gutter={4} modal={false} placement="bottom-start">
          <MenuV2.Trigger
            as="button"
            type="button"
            data-slot="operator-trail-crumb"
            aria-label={language.t("operator.overlay.trailMore")}
          >
            …
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <For each={view().hidden}>
                {(item) => <MenuV2.Item onSelect={() => goTo(item)}>{labelOf(item)}</MenuV2.Item>}
              </For>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </Show>
      <For each={view().last}>
        {(item) => (
          <>
            <span data-slot="operator-trail-separator">{" › "}</span>
            <Crumb item={item} last={isLast(item)} />
          </>
        )}
      </For>
    </nav>
  )
}
