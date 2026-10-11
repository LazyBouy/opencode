import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

// Each tool's permission pattern (memory_spec.md §9): on its card, asked for when a custom tool is
// created, and as help when a rule is added.

const dir = `?dir=${encodeURIComponent(directory)}`

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

test("a built-in tool's card shows its permission pattern from its code", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}&kind=tools&item=read`)
  const section = page.getByRole("dialog").getByTestId("tool-pattern")
  await expect(section.getByTestId("tool-pattern-permission")).toHaveText("read")
  await expect(section).toContainText("From its code")
  await expect(section.getByTestId("tool-pattern-text")).toContainText("relative to the project root")
  await expect(section.getByTestId("tool-pattern-examples")).toContainText('"*.env": "ask"')
  await expect(section.getByTestId("tool-pattern-defaults")).toContainText("Built in")
  await expect(section.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
})

test("a custom tool's pattern is edited on its card", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}&kind=tools&item=hello`)
  const section = page.getByRole("dialog").getByTestId("tool-pattern")
  await expect(section).toContainText("Not written yet")
  await expect(section.getByTestId("tool-pattern-text")).toContainText("As this tool asks: *")
  await section.getByRole("button", { name: "Edit", exact: true }).click()
  const form = section.getByTestId("tool-pattern-form")
  await form.getByLabel("Permission", { exact: true }).fill("greet")
  await form.getByLabel("Pattern", { exact: true }).fill("who is greeted")
  await form.getByRole("button", { name: "Add example" }).click()
  await form.getByRole("textbox", { name: "Example pattern" }).fill("world")
  await section.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.capabilityWrites.length).toBe(1)
  expect(state.capabilityWrites[0]).toMatchObject({
    action: "tool-pattern",
    body: {
      tool: "hello",
      permission: "greet",
      verbs: [],
      text: "who is greeted",
      examples: [{ pattern: "world", action: "ask" }],
    },
  })
  await expect(section.getByTestId("tool-pattern-permission")).toHaveText("greet")
})

test("a new custom tool is asked for its pattern: its id and * unless changed", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/capabilities${dir}&tab=tools`)
  await page.getByRole("button", { name: "New tool" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: true }).fill("deploy")
  await expect(dialog.getByTestId("tool-pattern-form").getByLabel("Permission", { exact: true })).toHaveValue("deploy")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect.poll(() => state.capabilityWrites.map((write) => write.action)).toEqual(["create", "tool-pattern"])
  expect(state.capabilityWrites[1]!.body).toEqual({
    tool: "deploy",
    permission: "deploy",
    verbs: [],
    text: "*",
    examples: [],
  })
})

test("adding a rule shows the permission's pattern and examples", async ({ page }) => {
  await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByRole("combobox", { name: "New rule's permission" }).fill("bash")
  const help = page.getByTestId("pattern-help")
  await expect(help).toContainText("Its pattern: The command")
  await expect(help).toContainText('"git push*": "ask"')
  await page.getByRole("combobox", { name: "New rule's permission" }).fill("memory")
  await expect(help).toContainText("VERB(<target>)")
})
