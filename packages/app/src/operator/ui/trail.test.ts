import { describe, expect, test } from "bun:test"
import { closeTarget, type Crumb, normalize, relabel, shown, visit, without } from "./trail"

const crumb = (depth: number, url: string, label = url): Crumb => ({ depth, url, label })

describe("the back path", () => {
  test("visits add crumbs; going back or replacing an entry cuts the trail there", () => {
    let trail: Crumb[] = []
    trail = visit(trail, crumb(1, "/operator", "Dashboard"))
    trail = visit(trail, crumb(2, "/operator/projects", "Projects"))
    trail = visit(trail, crumb(3, "/operator/projects?project=%2Fsrc%2Fopencode", "opencode"))
    expect(trail.map((item) => item.label)).toEqual(["Dashboard", "Projects", "opencode"])
    // Full screen replaces the entry: same depth, the crumb is replaced.
    trail = visit(trail, crumb(3, "/operator/projects?project=%2Fsrc%2Fopencode&full=1", "opencode"))
    expect(trail).toHaveLength(3)
    // Back.
    trail = visit(trail, crumb(2, "/operator/projects", "Projects"))
    expect(trail.map((item) => item.label)).toEqual(["Dashboard", "Projects"])
    // A pasted link in a new tab: only itself.
    expect(visit([], crumb(7, "/operator/agents?agent=build", "build"))).toHaveLength(1)
  })

  test("labels arrive after the visit; query order does not matter", () => {
    const trail = visit([], crumb(1, "/operator/agents?b=2&a=1", ""))
    expect(trail[0]!.url).toBe("/operator/agents?a=1&b=2")
    expect(relabel(trail, "/operator/agents?a=1&b=2", "Agents")[0]!.label).toBe("Agents")
    expect(relabel(trail, "/operator/other", "Other")[0]!.label).toBe("")
    expect(normalize("/x?b=1&a=2")).toBe("/x?a=2&b=1")
    expect(without("/x?project=p&dir=d&full=1", ["project", "full"])).toBe("/x?dir=d")
  })

  test("closing an overlay goes back to the page it was opened on, past its own entries", () => {
    const keys = ["project", "block", "full"]
    const trail = [
      crumb(1, "/operator"),
      crumb(2, "/operator/projects?dir=d"),
      crumb(3, normalize("/operator/projects?dir=d&block=opencode")),
      crumb(4, normalize("/operator/projects?dir=d&project=p")),
    ]
    expect(closeTarget(trail, keys)?.depth).toBe(2)
    // Opened from a link (no page crumb before it): cleared in place.
    expect(closeTarget(trail.slice(2), keys)).toBeUndefined()
    // Another page in between: cleared in place.
    expect(closeTarget([crumb(1, "/operator/projects"), crumb(2, "/operator/agents?project=p")], keys)).toBeUndefined()
  })

  test("a long trail shows its first crumb, the middle in a menu, and the last two", () => {
    const trail = [1, 2, 3, 4, 5].map((depth) => crumb(depth, `/p${depth}`))
    const view = shown(trail)
    expect(view.first.map((item) => item.depth)).toEqual([1])
    expect(view.hidden.map((item) => item.depth)).toEqual([2, 3])
    expect(view.last.map((item) => item.depth)).toEqual([4, 5])
    expect(shown(trail.slice(0, 3)).hidden).toEqual([])
  })
})
