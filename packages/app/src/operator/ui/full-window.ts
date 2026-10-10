// Full window (record overlays' Full screen, Settings' Maximize): a dialog fills the window below the
// title bar (or above it, when the title bar is at the bottom). Sets the bounds record-overlay.css reads,
// and returns what takes them away.
export function fullWindowBounds() {
  const bar = document.getElementById("opencode-titlebar-right")?.closest("header")?.getBoundingClientRect()
  const root = document.documentElement.style
  const atTop = !bar || bar.top < window.innerHeight / 2
  root.setProperty("--operator-full-top", atTop && bar ? `${bar.bottom}px` : "0px")
  root.setProperty("--operator-full-bottom", !atTop && bar ? `${window.innerHeight - bar.top}px` : "0px")
  return () => {
    root.removeProperty("--operator-full-top")
    root.removeProperty("--operator-full-bottom")
  }
}
