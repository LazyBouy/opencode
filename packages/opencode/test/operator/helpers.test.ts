import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// Helpers as namespace resources (agent_types_spec.md §4.2, §4.3, §4.8): every namespace lists the built-in
// helpers; its own are kept with it, their text a helper profile holding one helper layer, and go to Trash with
// that profile and layer.

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const app = () => Server.Default().app
const json = { "content-type": "application/json" }
const call = (method: string, url: string, body?: object) =>
  app().request(url, { method, headers: json, ...(body ? { body: JSON.stringify(body) } : {}) })
const read = async <T>(response: Response) => (await response.json()) as T
const message = async (response: Response) => (await read<{ data: { message: string } }>(response)).data.message
type Helper = {
  name: string
  namespace: string
  description?: string
  builtin: boolean
  roles: string[]
  model: { source: string; model?: string }
  profile: string
  layer?: string
  text: string
  steps?: number
  timeout?: number
  file?: string
}
const exists = (file: string) =>
  fs
    .stat(file)
    .then(() => true)
    .catch(() => false)

describe("helpers", () => {
  test("every namespace lists the built-in helpers, read-only, with their roles and text", async () => {
    const helpers = await read<Helper[]>(await call("GET", "/operator/helper?ns=opencode"))
    const builtins = helpers.filter((item) => item.builtin)
    expect(builtins.map((item) => item.name)).toEqual([
      "title",
      "summary",
      "compaction",
      "agent-generator",
      "purpose-generator",
      "dynamic-generator",
    ])
    const title = builtins.find((item) => item.name === "title")!
    expect(title).toMatchObject({
      roles: ["title"],
      model: { source: "small" },
      profile: "opencode:profile.helper.title",
    })
    expect(title.text).toContain("title")
    expect(builtins.find((item) => item.name === "compaction")!.model.source).toBe("chat")

    const update = await call("PATCH", "/operator/helper/opencode/title", { text: "Mine." })
    expect(update.status).toBe(400)
    expect(await message(update)).toContain("read-only")
    expect((await call("DELETE", "/operator/helper/opencode/title")).status).toBe(400)
  })

  test("a helper is created with its text as a helper profile, edited in place, and goes to Trash with it", async () => {
    const created = await call("POST", "/operator/helper/opencode", {
      name: "triager",
      description: "Sorts issues",
      model: { source: "small" },
      text: "Sort the issue into bug, feature or question.",
    })
    expect(created.status).toBe(200)
    const helper = await read<Helper>(created)
    expect(helper).toMatchObject({
      name: "triager",
      builtin: false,
      roles: [],
      model: { source: "small" },
      text: "Sort the issue into bug, feature or question.",
      steps: 5,
      timeout: 120,
    })
    expect(await exists(helper.file!)).toBe(true)

    // Its profile is a helper profile holding its layer; deleting that profile is refused while the helper exists.
    const catalog = await read<{ profiles: { id: string; slots: Record<string, string[]> }[] }>(
      await call("GET", "/operator/namespaces/opencode/catalog"),
    )
    expect(catalog.profiles.find((item) => item.id === helper.profile)?.slots.helper).toEqual([helper.layer!])
    const removeProfile = await call("DELETE", `/operator/namespaces/opencode/profiles/${helper.profile}`)
    expect(removeProfile.status).not.toBe(200)

    // Names: not a built-in's, not taken; limits in range.
    const named = await call("POST", "/operator/helper/opencode", {
      name: "title",
      model: { source: "small" },
      text: "x",
    })
    expect(await message(named)).toContain("built-in")
    const taken = await call("POST", "/operator/helper/opencode", {
      name: "triager",
      model: { source: "small" },
      text: "x",
    })
    expect(await message(taken)).toContain("already")
    const steps = await call("PATCH", "/operator/helper/opencode/triager", { steps: 30 })
    expect(await message(steps)).toContain("1 to 20")

    const edited = await read<Helper>(
      await call("PATCH", "/operator/helper/opencode/triager", {
        text: "Label it.",
        description: "",
        model: { source: "pick", model: "openai/gpt-5" },
        timeout: 60,
      }),
    )
    expect(edited).toMatchObject({ text: "Label it.", model: { source: "pick", model: "openai/gpt-5" }, timeout: 60 })
    expect(edited.description).toBeUndefined()
    const listed = await read<Helper[]>(await call("GET", "/operator/helper"))
    expect(listed.find((item) => item.namespace === "opencode" && item.name === "triager")?.text).toBe("Label it.")

    const trashed = await call("DELETE", "/operator/helper/opencode/triager")
    expect(trashed.status).toBe(200)
    const entry = await read<{ id: string; kind: string; files: { path: string }[] }>(trashed)
    expect(entry.kind).toBe("helper")
    expect(entry.files).toHaveLength(3)
    expect(await exists(helper.file!)).toBe(false)
    const after = await read<Helper[]>(await call("GET", "/operator/helper?ns=opencode"))
    expect(after.some((item) => item.name === "triager")).toBe(false)

    expect((await call("POST", `/operator/trash/${entry.id}/restore`)).status).toBe(200)
    const back = await read<Helper[]>(await call("GET", "/operator/helper?ns=opencode"))
    expect(back.find((item) => item.name === "triager")?.text).toBe("Label it.")
  })
})
