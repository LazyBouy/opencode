import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

// A Dynamic layer's rules (dynamic_layer_resolution_spec.md §6): OpenCode's read-only, Edit a copy, a
// layer of yours edited in place, and Test resolve with draft rules, a model and a session.

test.beforeEach(async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v1",
    sessions: fixture.sessions.map((session) => ({ ...session })),
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })
})

const pick = async (page: Page, label: string, option: string, nth = 0) => {
  await page
    .locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`)
    .nth(nth)
    .click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option}$`) })
    .click()
}

test("OpenCode's per-request layer shows its rules read-only; Edit a copy makes a Dynamic layer of yours with them", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers&layer=opencode:generated.instructions")
  const overlay = page.getByRole("dialog")
  const rules = overlay.getByTestId("layer-rules")
  await expect(rules).toContainText("OpenCode's rules: read-only. Edit a copy")
  await expect(rules.getByTestId("rules-source")).toHaveCount(6)
  await expect(rules.getByTestId("rules-source").nth(2)).toContainText("AGENTS.md")
  await expect(rules.getByTestId("rules-filters")).toHaveText("Found (an empty one stays)")
  await expect(rules.getByTestId("rules-scoring")).toHaveText("name in the order AGENTS.md, CLAUDE.md, CONTEXT.md × 10")
  await expect(rules.getByTestId("rules-selection")).toHaveText(
    "One: the best · per group: config=all · groups in the order global, project, config · each path once",
  )
  await expect(rules.getByTestId("rules-template")).toContainText("item: Instructions from: {path}\\n{text}")
  // OpenCode's own layers are not edited in place.
  await expect(overlay.getByTestId("rules-form")).toHaveCount(0)

  await rules.getByRole("button", { name: "Edit a copy" }).click()
  const form = overlay.getByTestId("rules-form")
  await expect(form.getByTestId("rules-source-line")).toHaveCount(6)
  await expect(overlay).toContainText("No helper source: the layer needs no prompt.")
  await expect(overlay.getByLabel("Prompt", { exact: true })).toHaveCount(0)
  // Every project file, not only the first name found.
  await form.getByRole("textbox", { name: "Policy per group" }).fill("config=all, project=all")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.filter((write) => write.method === "PUT").length).toBe(1)
  const created = state.prompt.writes.find((write) => write.method === "POST")!
  expect(created).toMatchObject({
    path: "/operator/namespaces/opencode/layers",
    body: { name: "Instructions – copy", type: "dynamic", section: "dynamic", text: "" },
  })
  const saved = state.prompt.writes.find((write) => write.method === "PUT")!.body as {
    resolver: { sources: unknown[]; select: { per: Record<string, string> } }
  }
  expect(saved.resolver.sources).toHaveLength(6)
  expect(saved.resolver.select.per).toEqual({ config: "all", project: "all" })
  await expect(overlay.getByTestId("layer-rules")).toContainText("Its own rules.")
  await expect(overlay.getByTestId("rules-selection")).toContainText("per group: config=all, project=all")
})

test("a Dynamic layer of yours: its rules edited in place, then Test resolve with draft rules, a model and a session", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  await page.locator('[data-section="dynamic"]').getByRole("button", { name: "New Dynamic layer" }).click()
  const overlay = page.getByRole("dialog")
  const form = overlay.getByTestId("rules-form")
  // By default a helper writes it from its prompt, once per session.
  await expect(form.getByTestId("rules-source-line")).toHaveCount(1)
  await expect(overlay.getByLabel("Prompt", { exact: true })).toBeVisible()
  await overlay.getByLabel("Name", { exact: true }).fill("Recent notes")
  // The newest notes instead: no prompt needed.
  await pick(page, "Kind", "File")
  await form.getByRole("textbox", { name: "Location" }).fill("notes/*.md")
  await expect(overlay.getByLabel("Prompt", { exact: true })).toHaveCount(0)
  await form.getByRole("button", { name: "Add rule" }).click()
  await expect(form.getByTestId("rules-rule-line")).toHaveCount(1)
  await pick(page, "Policy", "Top N")
  await expect(form.getByRole("textbox", { name: "How many" })).toHaveValue("3")
  await form.getByRole("textbox", { name: "Header" }).fill("<notes>\\n")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  const body = state.prompt.writes[0]!.body as {
    prompt: string
    resolver: { sources: unknown[]; score: unknown[]; select: unknown; template: { header?: string } }
  }
  expect(body.prompt).toBe("")
  expect(body.resolver.sources).toEqual([{ kind: "file", location: "notes/*.md" }])
  expect(body.resolver.score).toEqual([{ kind: "recency", weight: 1 }])
  expect(body.resolver.select).toEqual({ policy: "top", n: 3 })
  expect(body.resolver.template.header).toBe("<notes>\n")

  // Its view: its own rules, and its sample.
  const rules = overlay.getByTestId("layer-rules")
  await expect(rules).toContainText("Its own rules.")
  await expect(rules.getByTestId("rules-scoring")).toHaveText("Newest first × 1")
  await expect(rules.getByTestId("rules-selection")).toHaveText("The top 3")

  // Test resolve tries draft rules, here with another model and a session, without saving them.
  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await form.getByRole("textbox", { name: "How many" }).fill("1")
  await pick(page, "Model", "opencode/claude-opus-4-6")
  await pick(page, "Session", "Fix the parser")
  await overlay.getByRole("button", { name: "Test resolve" }).click()
  const status = overlay.getByRole("status")
  await expect(status).toContainText("Resolved from notes/*.md (top 1)")
  await expect(status.getByTestId("prompt-trace")).toContainText('Resolved by the rules of "Recent notes"')
  await status.getByTestId("prompt-resolution").locator("summary").click()
  await expect(status.getByTestId("resolution-candidate")).toHaveCount(1)
  const asked = state.prompt.samples.at(-1)!
  expect(asked).toMatchObject({ agent: "build", provider: "opencode", model: "claude-opus-4-6", session: "ses_op_1" })
  expect(JSON.parse(asked.resolver!).select).toEqual({ policy: "top", n: 1 })
  expect(state.prompt.writes).toHaveLength(1)
})

test("a helper judge on a Dynamic layer of yours: chosen with its weight and instructions, shown, and in the trace", async ({
  page,
}) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  await page.locator('[data-section="dynamic"]').getByRole("button", { name: "New Dynamic layer" }).click()
  const overlay = page.getByRole("dialog")
  const form = overlay.getByTestId("rules-form")
  await overlay.getByLabel("Name", { exact: true }).fill("Picked notes")
  await pick(page, "Kind", "File")
  await form.getByRole("textbox", { name: "Location" }).fill("notes/*.md")

  // Off by default; on, it takes a helper of the namespace that only reads.
  const judge = form.getByTestId("rules-judge-form")
  await expect(judge.getByRole("combobox")).toHaveCount(0)
  await judge.getByText("Let a helper judge").click()
  await expect(
    judge.locator('[data-component="select-v2-root"][aria-label="Judge"] [data-component="select-v2"]'),
  ).toContainText("sorter")
  await judge.getByRole("textbox", { name: "Judge's weight" }).fill("2")
  await judge.getByRole("textbox", { name: "How to judge" }).fill("Prefer short notes.")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect((state.prompt.writes[0]!.body as { resolver: { judge?: unknown } }).resolver.judge).toEqual({
    helper: "sorter",
    weight: 2,
    instructions: "Prefer short notes.",
  })
  await expect(overlay.getByTestId("layer-rules").getByTestId("rules-judge")).toContainText("sorter × 2")

  // Test resolve: what the judge did, and its points beside each score.
  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await overlay.getByRole("button", { name: "Test resolve" }).click()
  const status = overlay.getByRole("status")
  await status.getByTestId("prompt-resolution").locator("summary").click()
  await expect(status.getByTestId("resolution-judge")).toHaveText("Judged by sorter: asked now.")
  await expect(status.getByTestId("resolution-candidate").first()).toContainText("(judge 1.80)")
})
