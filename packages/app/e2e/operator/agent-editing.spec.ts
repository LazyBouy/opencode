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
  await page.getByLabel("Description").fill("Writes docs")
  await page.getByRole("button", { name: "Subagent", exact: true }).click()
  await page.getByLabel("Temperature").fill("0.3")
  await page.getByLabel("Home folder").fill("/work/docs")
  await page.getByLabel("Prompt").fill("Write clear docs.")
  await page.getByRole("button", { name: "Add rule" }).click()
  await page.getByRole("textbox", { name: "Permission, such as bash or edit" }).fill("edit")
  await page.getByRole("button", { name: "Create agent" }).click()

  await expect.poll(() => state.agentWrites.length).toBe(1)
  const write = state.agentWrites[0]
  expect(write.method).toBe("POST")
  expect(new URL(write.url).searchParams.get("scope")).toBe("project")
  expect(write.body).toEqual({
    name: "docs",
    description: "Writes docs",
    mode: "subagent",
    temperature: 0.3,
    home: "/work/docs",
    prompt: "Write clear docs.",
    permission: { edit: "ask" },
  })
  await expect(page).toHaveURL(/\/operator\/agents\/docs\?dir=/)
})

test("editing a built-in agent sends only what changed and resets cleared settings", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/agents/build/edit${dir}`)
  const temperature = page.getByLabel("Temperature")
  await expect(temperature).toHaveValue("0.1")
  await temperature.fill("")
  await page.getByLabel("Description").fill("Builds things")
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

  await page.getByRole("button", { name: "Delete" }).click()
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click()
  await expect.poll(() => state.agentWrites.length).toBe(2)
  expect(state.agentWrites[1].method).toBe("DELETE")
  await expect(page).toHaveURL(/\/operator\/agents\?dir=/)
})

test("the prompt profile lists layers, saves edits, reorders and previews per agent", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto(`/operator/profile${dir}`)
  const layers = page.locator('[data-component="operator-layers"] li')
  await expect(layers).toHaveCount(3)
  await expect(layers.nth(0)).toContainText("Company")
  await expect(layers.nth(2)).toContainText("Only build")

  await page.getByRole("button", { name: "Move Style up" }).click()
  await expect.poll(() => state.identityWrites.length).toBe(1)
  expect(state.identityWrites[0].body).toEqual({ scope: "project", files: ["style.md", "repo.md"] })

  await layers.nth(1).getByRole("button").first().click()
  await page.getByLabel("Text").fill("This repo uses Bun 1.3.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.identityWrites.length).toBe(2)
  expect(state.identityWrites[1].body).toMatchObject({
    scope: "project",
    file: "repo.md",
    content: "This repo uses Bun 1.3.",
  })

  await expect(page.locator('[data-component="operator-code"]')).toContainText("Use tabs.")
})
