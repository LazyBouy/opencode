// The box of a resized overlay (resizable-dialogs.ts): dragging an edge or a corner by (dx, dy), kept within the
// window and above a minimum size; the opposite edges stay where they are.

export type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
export type Box = { left: number; top: number; width: number; height: number }

export const MIN_WIDTH = 320
export const MIN_HEIGHT = 200
const MARGIN = 8

/** The box after dragging an edge by (dx, dy), kept within the window and above the minimum size. */
export function resized(start: Box, edge: Edge, dx: number, dy: number, view: { width: number; height: number }): Box {
  let { left, top, width, height } = start
  const right = start.left + start.width
  const bottom = start.top + start.height
  if (edge.includes("e")) width = Math.min(view.width - MARGIN - left, Math.max(MIN_WIDTH, start.width + dx))
  if (edge.includes("s")) height = Math.min(view.height - MARGIN - top, Math.max(MIN_HEIGHT, start.height + dy))
  if (edge.includes("w")) {
    left = Math.max(MARGIN, Math.min(right - MIN_WIDTH, start.left + dx))
    width = right - left
  }
  if (edge.includes("n")) {
    top = Math.max(MARGIN, Math.min(bottom - MIN_HEIGHT, start.top + dy))
    height = bottom - top
  }
  return { left, top, width, height }
}
