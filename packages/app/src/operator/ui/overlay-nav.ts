import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type SetParams, useBeforeLeave, useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { closeTarget, type Crumb, load, normalize, relabel, save, visit } from "./trail"

// How the operator moves through its pages and records (fixes_spec.md §1): the back path, what an
// overlay's Back and Close do, and the questions asked before an edit is lost.
//
// History: opening a page, an overlay or a record of another page adds an entry; everything inside an
// open overlay (its menu, sections, ‹ ›, Full screen, Edit) replaces it. So Back, or Close, returns to
// the page the overlay was opened on.

// ---- Labels: what the current crumb is called (an open record's name, else the page's title) ----

type Label = { token: object; label: string }
const [pageLabel, setPageLabel] = createSignal<Label>()
const [recordLabels, setRecordLabels] = createSignal<Label[]>([])

function useLabel(label: () => string | undefined, set: (token: object, label: string | undefined) => void) {
  const token = {}
  createEffect(() => set(token, label()))
  onCleanup(() => set(token, undefined))
}

export function usePageLabel(label: () => string) {
  useLabel(label, (token, value) =>
    setPageLabel((current) =>
      value !== undefined ? { token, label: value } : current?.token === token ? undefined : current,
    ),
  )
}

export function useRecordLabel(label: () => string | undefined) {
  useLabel(label, (token, value) =>
    setRecordLabels((list) => {
      const rest = list.filter((item) => item.token !== token)
      return value ? [...rest, { token, label: value }] : rest
    }),
  )
}

const crumbLabel = () => recordLabels().at(-1)?.label ?? pageLabel()?.label ?? ""

// ---- The trail ----

const [trail, setTrail] = createSignal<Crumb[]>(load())
export const useTrail = () => trail

const update = (next: Crumb[]) => {
  setTrail(next)
  save(next)
}

// This entry's place in the tab's history (the router keeps it in the history state; the desktop app's
// in-memory router does not, so there a crumb already on the trail is a step back, anything else a step
// forward).
export function historyDepth(): number | undefined {
  const depth = (window.history.state as { _depth?: unknown } | null)?._depth
  return typeof depth === "number" ? depth : undefined
}

function depthOf(url: string) {
  const known = historyDepth()
  if (known !== undefined) return known
  const list = trail()
  return list.find((crumb) => crumb.url === normalize(url))?.depth ?? (list.at(-1)?.depth ?? 0) + 1
}

// Goes to a crumb: back through the history to it (so the browser's Back and Forward still match).
export function useGoTo() {
  const navigate = useNavigate()
  return (crumb: Crumb) => {
    const depth = historyDepth()
    if (depth !== undefined && crumb.depth < depth) navigate(crumb.depth - depth)
    else navigate(crumb.url)
  }
}

// ---- Overlays: their frames register so Esc and the backdrop can ask before an edit is lost ----

export type OpenFrame = {
  element: () => HTMLElement | undefined
  full: () => boolean
  exitFull: () => void
  editing: () => boolean
  // Closes it; while editing, after asking.
  close: () => void
  // Asks before its edit is lost; true to go on.
  ask: () => Promise<boolean>
  // Whether it is asking, and its answer (Esc: Cancel).
  asking: () => boolean
  answer: (ok: boolean) => void
}
const frames: OpenFrame[] = []

export function registerFrame(frame: OpenFrame) {
  frames.push(frame)
  onCleanup(() => {
    const at = frames.indexOf(frame)
    if (at >= 0) frames.splice(at, 1)
  })
}

// The open overlay that is on top (not under a question or another dialog).
function topFrame() {
  const frame = frames.at(-1)
  const element = frame?.element()
  if (!frame || !element) return undefined
  const layers = document.querySelectorAll("[data-dialog-layer]")
  const top = layers[layers.length - 1]
  return top?.contains(element) ? frame : undefined
}

// Search params inside an open overlay: a change replaces the history entry unless it says otherwise.
export function useOverlayParams<T extends Record<string, string | string[] | undefined>>() {
  const [params, setParams] = useSearchParams<T>()
  const set = (next: SetParams, options?: { replace?: boolean }) => setParams(next, { replace: true, ...options })
  return [params, set] as const
}

// Closing an overlay (Close, Esc, the backdrop): back to the page it was opened on when the history
// has it just behind the overlay's entries, else its keys are cleared in place. Unless what closed it
// went somewhere else at once (a link in the overlay).
export function useCloseOverlay(keys: ReadonlyArray<string>, clear: () => void) {
  const navigate = useNavigate()
  const location = useLocation()
  const href = () => `${location.pathname}${location.search}`
  return () => {
    const at = href()
    setTimeout(() => {
      if (href() !== at) return
      const target = closeTarget(trail(), keys)
      const depth = historyDepth()
      if (target && depth !== undefined && target.depth < depth) navigate(target.depth - depth)
      else clear()
    })
  }
}

// ---- The keeper, mounted once by the operator sidebar ----

export function useTrailKeeper() {
  const location = useLocation()
  const dialog = useDialog()
  const href = () => `${location.pathname}${location.search}`

  // Every operator page and record visited is a crumb; its label comes when the page or record says it.
  createEffect(
    on(href, (url) => {
      if (!location.pathname.startsWith("/operator")) return
      // After the router has written the history entry (its depth with it) and the page has said what it
      // is.
      setTimeout(() => {
        if (href() !== url) return
        update(visit(trail(), { depth: depthOf(url), url, label: crumbLabel() }))
      })
    }),
  )
  createEffect(
    on(crumbLabel, (label) => {
      if (!label) return
      const next = relabel(trail(), href(), label)
      if (next.at(-1)?.label !== trail().at(-1)?.label) update(next)
    }),
  )

  // Esc: out of full screen first; while editing, the overlay asks before it closes. (Before the
  // dialog's own Esc, which is registered later.) The backdrop asks the same while editing.
  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const frame = topFrame()
      if (!frame) return
      if (frame.asking()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        frame.answer(false)
        return
      }
      if (frame.full()) {
        event.preventDefault()
        event.stopImmediatePropagation()
        frame.exitFull()
        return
      }
      if (!frame.editing()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      frame.close()
    }
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.matches('[data-component="dialog-overlay"]')) return
      const frame = frames.at(-1)
      if (!frame?.editing() || !dialog.active) return
      event.preventDefault()
      event.stopImmediatePropagation()
      frame.close()
    }
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("click", onClick, true)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("click", onClick, true)
    })
  })

  // Leaving the page while editing asks too (changes inside the overlay don't leave it).
  useBeforeLeave((event) => {
    const frame = frames.findLast((item) => item.editing())
    if (!frame || event.defaultPrevented) return
    if (typeof event.to === "string" && new URL(event.to, "http://local").pathname === location.pathname) return
    event.preventDefault()
    void frame.ask().then((ok) => {
      if (ok) event.retry(true)
    })
  })
}
