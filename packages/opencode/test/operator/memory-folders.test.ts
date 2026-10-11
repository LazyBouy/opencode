import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { OperatorMemoryFolders as F } from "@/operator/memory-folders"
import { tmpdir } from "../fixture/fixture"

// Where short-term memory lives, and .memory kept out of git (memory_spec.md §2).

const settingsFile = () => path.join(Global.Path.config, "namespaces", "memory.json")
afterEach(() => fs.rm(settingsFile(), { force: true }))

describe("the .memory folders", () => {
  test("the project's at its root; an agent's in its home, else under the project's .memory/agents/", async () => {
    await using project = await tmpdir()
    const found = await F.of({ project: project.path, agent: { name: "build" } })
    expect(found.project).toBe(path.join(project.path, ".memory"))
    expect(found.agent).toBe(path.join(project.path, ".memory", "agents", "build"))
    expect(F.agentFolder(project.path, { name: "docs", home: "agents/docs/" })).toBe(
      path.join(project.path, "agents", "docs", ".memory"),
    )
    // A project outside every namespace folder is in OpenCode, which is Global's folder with no working
    // directory set.
    expect(found.namespace).toEqual({ id: "opencode", folder: path.join(Global.Path.config, ".memory") })
  })
})

describe("keeping .memory out of git", () => {
  test("by default the repository's info/exclude gets the line; committing takes it out again", async () => {
    await using project = await tmpdir({ git: true })
    const folder = await F.ensure(path.join(project.path, ".memory"), project.path)
    await fs.writeFile(path.join(folder, "MEMORY.md"), "- [A](a.md) — A memory\n")
    const exclude = path.join(project.path, ".git", "info", "exclude")
    expect(await fs.readFile(exclude, "utf8")).toContain(".memory/\n")
    expect((await $`git status --porcelain`.cwd(project.path).text()).trim()).toBe("")
    expect(await Bun.file(path.join(project.path, ".gitignore")).exists()).toBe(false)

    // Committing: the line OpenCode added is taken out, and git sees the folder.
    const known = [{ key: project.path, name: "project" }]
    const saved = await F.update({ commit: true }, known)
    expect(saved.commit).toBe(true)
    expect(await fs.readFile(exclude, "utf8")).not.toContain(".memory/")
    expect(await $`git status --porcelain`.cwd(project.path).text()).toContain(".memory/")

    // A project's own choice wins over the default; null goes back to it.
    await F.update({ project: { key: project.path, commit: false } }, known)
    expect(await fs.readFile(exclude, "utf8")).toContain(".memory/")
    const view = await F.update({ project: { key: project.path, commit: null } }, known)
    expect(await fs.readFile(exclude, "utf8")).not.toContain(".memory/")
    expect(view.projects.find((item) => item.key === project.path)).toMatchObject({
      name: "project",
      commits: true,
      excluded: false,
      repo: project.path,
    })
  })

  test("a line the user wrote stays; a linked worktree uses its main repository's exclude", async () => {
    await using project = await tmpdir({ git: true })
    const exclude = path.join(project.path, ".git", "info", "exclude")
    await fs.appendFile(exclude, ".memory\n")
    await F.ensure(path.join(project.path, ".memory"), project.path)
    await F.update({ commit: true }, [{ key: project.path, name: "project" }])
    expect(await fs.readFile(exclude, "utf8")).toContain(".memory\n")

    await using linked = await tmpdir()
    const worktree = path.join(linked.path, "wt")
    await $`git worktree add ${worktree}`.cwd(project.path).quiet()
    const found = await F.excludeFile(path.join(worktree, ".memory"))
    expect(found).toEqual({ repo: worktree, file: exclude })
  })

  test("the index limits default to 200 lines and 25,000 characters; below 1 is refused", async () => {
    expect(await F.view([])).toMatchObject({ commit: false, indexLines: 200, indexChars: 25_000 })
    await expect(F.update({ indexLines: 0 }, [])).rejects.toThrow("A limit must be at least 1")
    expect((await F.update({ indexLines: 50 }, [])).indexLines).toBe(50)
  })
})

describe("settings per namespace", () => {
  test("a namespace follows OpenCode's until it sets its own; its projects can still choose", async () => {
    const known = [
      { key: "/p/a", name: "a", namespace: "acme" },
      { key: "/p/o", name: "o", namespace: "opencode" },
    ]
    expect(await F.view(known, "acme")).toMatchObject({ namespace: "acme", commit: false, indexLines: 200, own: false })
    await F.update({ indexLines: 120 }, known)
    expect((await F.view(known, "acme")).indexLines).toBe(120)
    const acme = await F.update({ namespace: "acme", commit: true, indexChars: 9000 }, known)
    expect(acme).toMatchObject({ commit: true, indexLines: 120, indexChars: 9000, own: true })
    expect(await F.view(known, "opencode")).toMatchObject({ commit: false, indexChars: 25_000 })
    expect(F.commits(await F.settings(), "/p/a", "acme")).toBe(true)
    expect(F.commits(await F.settings(), "/p/a", "opencode")).toBe(false)
    await F.update({ project: { key: "/p/a", commit: false } }, known)
    expect(F.commits(await F.settings(), "/p/a", "acme")).toBe(false)
    expect(await F.update({ namespace: "acme", follow: true }, known)).toMatchObject({ own: false, commit: false })
  })
})
