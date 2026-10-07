// Keeps what the reader sees where it is while the Transcript grows or shrinks around it: details
// loading as cards come into view, Expand everything, a live refresh, opening and closing. The
// browser's own scroll anchoring does not hold through large growth above the view, so the
// Transcript anchors itself: it remembers the element at the top of the view, and whenever the
// content resizes, it moves the scroll position by however much that element moved. What the user
// clicks is pinned instead, so the control stays under the pointer.

// The elements an anchor is chosen from: small blocks, so the one at the top of the view is close to
// what is being read.
const ANCHORS = [
  '[data-slot="operator-transcript-section-head"]',
  '[data-slot="operator-transcript-exchange"]',
  '[data-component="operator-call"] > header',
  '[data-component="operator-call"] tr',
  '[data-component="operator-call"] h4',
  '[data-slot="operator-call-item"]',
  '[data-slot="operator-call-seen"]',
  '[data-component="operator-call"] pre',
  '[data-component="operator-call"] p',
  '[data-slot="operator-call-raw"]',
].join(", ")

type Anchor = { element: Element; offset: number }
const anchors = new WeakMap<Element, { pin: (element: Element) => void }>()

export function createScrollAnchor(scroller: HTMLElement, contents: ReadonlyArray<HTMLElement>) {
  let anchor: Anchor | undefined
  let adjusted = false
  const offsetOf = (element: Element) => element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const pick = () => {
    const top = scroller.getBoundingClientRect().top
    for (const element of scroller.querySelectorAll(ANCHORS)) {
      const box = element.getBoundingClientRect()
      if (box.height > 0 && box.bottom > top + 1) {
        anchor = { element, offset: box.top - top }
        return
      }
    }
    anchor = undefined
  }
  const onScroll = () => {
    // The scroll this anchoring caused keeps the anchor; the reader's own scroll picks a new one.
    if (adjusted) {
      adjusted = false
      return
    }
    pick()
  }
  const hold = () => {
    if (!anchor || !anchor.element.isConnected) return pick()
    const moved = offsetOf(anchor.element) - anchor.offset
    if (Math.abs(moved) < 1) return
    adjusted = true
    scroller.scrollTop += moved
  }
  const observer = new ResizeObserver(hold)
  for (const content of contents) observer.observe(content)
  scroller.addEventListener("scroll", onScroll, { passive: true })
  pick()
  const api = {
    // A control in view stays where it is; one out of view (Expand everything, at the top) leaves the
    // anchor on what is being read.
    pin: (element: Element) => {
      const box = element.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      if (box.bottom > view.top && box.top < view.bottom) anchor = { element, offset: box.top - view.top }
      else pick()
    },
  }
  anchors.set(scroller, api)
  return () => {
    observer.disconnect()
    scroller.removeEventListener("scroll", onScroll)
    anchors.delete(scroller)
  }
}

// Runs a change the user made with `control`, keeping the control where it is on screen.
export function keepInPlace(control: Element | null | undefined, change: () => void) {
  const scroller = control?.closest('[data-component="operator-transcript"]')
  const api = scroller ? anchors.get(scroller) : undefined
  if (control && api) api.pin(control)
  change()
}
