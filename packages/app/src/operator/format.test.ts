import { describe, expect, test } from "bun:test"
import { crumbs, formatAgo, formatBytes, formatCost, formatCount, sessionFolder, shortPath } from "./format"

describe("operator formatting", () => {
  test("money keeps cents, with more precision below a dollar", () => {
    expect(formatCost(12.5, "en")).toBe("$12.50")
    expect(formatCost(0.0123, "en")).toBe("$0.0123")
    expect(formatCost(0, "en")).toBe("$0.00")
  })

  test("large counts are compact", () => {
    expect(formatCount(950, "en")).toBe("950")
    expect(formatCount(12_345, "en")).toBe("12.3K")
  })

  test("times read as relative, and empty times as nothing", () => {
    expect(formatAgo(Date.now() - 2 * 60 * 60 * 1000, "en")).toBe("2 hours ago")
    expect(formatAgo(undefined, "en")).toBe("")
  })

  test("paths keep their last two segments", () => {
    expect(shortPath("/root/projects/phi/i-phi")).toBe("…/phi/i-phi")
    expect(shortPath("C:\\work\\app")).toBe("…/work/app")
    expect(shortPath("/work")).toBe("/work")
  })

  test("a session's folder is its project root, or its own folder outside git projects", () => {
    expect(sessionFolder({ directory: "/work/app/pkg", project: { worktree: "/work/app" } })).toBe("/work/app")
    expect(sessionFolder({ directory: "/root/.local", project: { worktree: "/" } })).toBe("/root/.local")
    expect(sessionFolder({ directory: "/tmp/x", project: null })).toBe("/tmp/x")
  })

  test("bytes are shown in the largest whole unit", () => {
    expect(formatBytes(0, "en")).toBe("0 B")
    expect(formatBytes(512, "en")).toBe("512 B")
    expect(formatBytes(1536, "en")).toBe("1.5 KB")
    expect(formatBytes(5 * 1024 * 1024, "en")).toBe("5 MB")
  })

  test("breadcrumbs run from the workspace root to the folder", () => {
    expect(crumbs("/root/projects", "/root/projects")).toEqual([{ name: "/root/projects", path: "/root/projects" }])
    expect(crumbs("/root/projects", "/root/projects/app/web")).toEqual([
      { name: "/root/projects", path: "/root/projects" },
      { name: "app", path: "/root/projects/app" },
      { name: "web", path: "/root/projects/app/web" },
    ])
    expect(crumbs("/", "/srv/x").map((crumb) => crumb.path)).toEqual(["/", "/srv", "/srv/x"])
  })
})
