import { expect, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { directory, mockOperator } from "./mock-operator"

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

test("creating an agent sends its settings and rules, then opens it", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents${dir}`)
  await page.getByRole("button", { name: "New agent" }).click()
  await expect(page).toHaveURL(/\/operator\/agents\/new\?dir=/)

  await page.getByLabel("Name", { exact: true }).fill("docs")
  await page.getByLabel("Description", { exact: true }).fill("Writes docs")
  await page.getByRole("button", { name: "Subagent", exact: true }).click()
  await page.getByLabel("Temperature", { exact: true }).fill("0.3")
  await page.getByLabel("Home folder", { exact: true }).fill("/work/docs")
  await page.getByLabel("Prompt", { exact: true }).fill("Write clear docs.")
  await page.getByRole("combobox", { name: "New rule's permission" }).fill("edit")
  await page.getByRole("button", { name: "Add rule" }).click()
  await page.getByRole("button", { name: "Create agent" }).click()

  await expect.poll(() => state.agentWrites.length).toBe(1)
  const write = state.agentWrites[0]
  expect(write.method).toBe("POST")
  expect(new URL(write.url).searchParams.get("scope")).toBe("project")
  expect(write.body).toEqual({
    name: "docs",
    format: "file",
    description: "Writes docs",
    mode: "subagent",
    temperature: 0.3,
    home: "/work/docs",
    prompt: "Write clear docs.",
    permission: { edit: "ask" },
  })
  // Saved: the agent opens in the Agents page's overlay.
  await expect(page).toHaveURL(/\/operator\/agents\?.*agent=docs/)
})

test("a new agent is saved as an agent file or a config entry, and the form says where", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  await page.getByLabel("Name", { exact: true }).fill("docs")
  const target = page.getByTestId("agent-target")
  await expect(target).toHaveText(/^Saved to .*\/\.opencode\/agents\/docs\.md$/)
  await page.getByRole("button", { name: "Global", exact: true }).click()
  await expect(target).toHaveText("Saved to /home/me/.config/opencode/agents/docs.md")
  await page.getByRole("button", { name: "Config entry", exact: true }).click()
  await expect(target).toHaveText("Saved to /home/me/.config/opencode/opencode.jsonc → agent.docs")
  await page.getByRole("button", { name: "Create agent" }).click()

  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(new URL(state.agentWrites[0].url).searchParams.get("scope")).toBe("global")
  expect(state.agentWrites[0].body).toMatchObject({ name: "docs", format: "config" })
})

test("a new agent works in agents/<name>/ unless its home is changed or cleared", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/new${dir}`)
  const home = page.getByLabel("Home folder", { exact: true })
  await page.getByLabel("Name", { exact: true }).fill("docs")
  await expect(home).toHaveValue("agents/docs/")
  await page.getByLabel("Name", { exact: true }).fill("writer")
  await expect(home).toHaveValue("agents/writer/")
  // Cleared: it works at the project root, and the name no longer changes it.
  await home.fill("")
  await page.getByLabel("Name", { exact: true }).fill("editor")
  await expect(home).toHaveValue("")
  await page.getByRole("button", { name: "Create agent" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0].body).not.toHaveProperty("home")
})

test("editing a built-in agent sends only what changed and resets cleared settings", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build/edit${dir}`)
  const temperature = page.getByLabel("Temperature", { exact: true })
  await expect(temperature).toHaveValue("0.1")
  await temperature.fill("")
  await page.getByLabel("Description", { exact: true }).fill("Builds things")
  await page.getByRole("button", { name: "Save", exact: true }).click()

  await expect.poll(() => state.agentWrites.length).toBe(1)
  const write = state.agentWrites[0]
  expect(write.method).toBe("PATCH")
  expect(new URL(write.url).pathname).toBe("/operator/agent/build")
  expect(write.body).toEqual({ description: "Builds things", reset: ["temperature"] })
})

test("starting a session as an agent opens it in the agent's home folder", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build${dir}`)
  await page.getByRole("button", { name: "Start a session" }).click()
  await expect.poll(() => state.sessionCreates.length).toBe(1)
  expect(state.sessionCreates[0].body).toMatchObject({ agent: "build" })
  expect(new URL(state.sessionCreates[0].url).searchParams.get("directory")).toBe(directory)
  await expect(page).toHaveURL(/\/session\/ses_op_new$/)
})

test("a file agent can be turned off and deleted", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/reviewer${dir}`)
  await expect(page.locator('[data-component="operator-facts"]')).toContainText("/work/reviews")
  await page.getByRole("button", { name: "Turn off" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect(state.agentWrites[0].body).toEqual({ disable: true })

  // Delete moves it to Trash, after asking over the overlay.
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Move reviewer to Trash?" })).toBeVisible()
  await page.getByRole("button", { name: "Yes, move to Trash" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(2)
  expect(state.agentWrites[1].method).toBe("DELETE")
  await expect(page).toHaveURL(/\/operator\/agents\?dir=/)
  await expect(page).not.toHaveURL(/agent=/)
})
