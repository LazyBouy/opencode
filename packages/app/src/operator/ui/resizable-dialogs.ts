import { onCleanup, onMount } from "solid-js"
import { type Edge, resized } from "./resize-box"
import "./resizable-dialogs.css"

// Every overlay box can be resized (the user, 2026-10-11): each dialog's container (dialog-v2: record overlays,
// questions, Settings, the folder browser…) gets handles on its four edges (horizontal or vertical) and four
// corners (diagonal). The first drag pins the box where it is; its size and place are kept until it closes.
// Full screen (and Settings' Maximize) leaves them aside. Mounted once, from the sidebar.
//
// A press on a handle is taken at the window, before the dialog sees it: the handles sit on the container,
// outside the dialog's content, and the dialog would otherwise close as for a click outside it.

const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const

const FULL = "operator-overlay-full"

function install(container: HTMLElement) {
  if (container.hasAttribute("data-resizable")) return
  container.setAttribute("data-resizable", "")
  for (const edge of EDGES) {
    const handle = document.createElement("div")
    handle.setAttribute("data-resize-handle", edge)
    handle.setAttribute("aria-hidden", "true")
    container.appendChild(handle)
  }
}

function place(container: HTMLElement, box: { left: number; top: number; width: number; height: number }) {
  container.setAttribute("data-resized", "")
  container.style.setProperty("--operator-dialog-left", `${box.left}px`)
  container.style.setProperty("--operator-dialog-top", `${box.top}px`)
  container.style.setProperty("--operator-dialog-width", `${box.width}px`)
  container.style.setProperty("--operator-dialog-height", `${box.height}px`)
}

function begin(event: PointerEvent, handle: HTMLElement) {
  const container = handle.parentElement
  if (!container || container.classList.contains(FULL)) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const edge = handle.getAttribute("data-resize-handle") as Edge
  const rect = container.getBoundingClientRect()
  const start = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  place(container, start)
  container.setAttribute("data-resizing", "")
  const move = (next: PointerEvent) => {
    place(
      container,
      resized(start, edge, next.clientX - event.clientX, next.clientY - event.clientY, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    )
  }
  const end = () => {
    container.removeAttribute("data-resizing")
    window.removeEventListener("pointermove", move, true)
    window.removeEventListener("pointerup", end, true)
    window.removeEventListener("pointercancel", end, true)
  }
  window.addEventListener("pointermove", move, true)
  window.addEventListener("pointerup", end, true)
  window.addEventListener("pointercancel", end, true)
}

export function useResizableDialogs() {
  onMount(() => {
    const scan = (root: ParentNode) => {
      if (root instanceof HTMLElement && root.matches('[data-slot="dialog-container"]')) install(root)
      root.querySelectorAll?.<HTMLElement>('[data-slot="dialog-container"]').forEach(install)
    }
    scan(document.body)
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) scan(node)
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      const handle = (event.target as Element | null)?.closest?.("[data-resize-handle]")
      if (handle instanceof HTMLElement) begin(event, handle)
    }
    window.addEventListener("pointerdown", down, true)
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("pointerdown", down, true)
    })
  })
}
