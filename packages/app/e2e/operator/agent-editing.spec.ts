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
  await page.getByLabel("Prompt", { exact: true }).fill("Write clear docs.")
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

test("an agent's prompt mode is saved: Full custom with chosen sections, or the profile plus layers", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.profile.layers.push({
    id: "reviewer",
    name: "Reviewer",
    section: "role",
    projects: "*",
    priority: 50,
    enabled: true,
    text: "You review.",
    origin: "profile",
  })
  await page.goto(`/operator/agents/build/edit${dir}`)
  const prompt = page.getByRole("group", { name: "Prompt profile", exact: true })

  await prompt.getByRole("button", { name: "Full custom", exact: true }).click()
  await prompt.getByText("Skills", { exact: true }).click()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  expect((state.agentWrites[0].body as { promptProfile?: unknown }).promptProfile).toEqual({
    mode: "custom",
    generated: ["environment", "references", "instructions", "mcp"],
  })

  await page.goto(`/operator/agents/build/edit${dir}`)
  await prompt.getByRole("button", { name: "Profile + layers", exact: true }).click()
  await prompt.getByRole("group", { name: "Group", exact: true }).locator('[data-component="select-v2"]').click()
  await page.getByRole("option", { name: "Role", exact: true }).click()
  await prompt.getByRole("group", { name: "Layer", exact: true }).locator('[data-component="select-v2"]').click()
  await page.getByRole("option", { name: "Reviewer · Role" }).click()
  await prompt.getByRole("button", { name: "Add", exact: true }).click()
  await expect(prompt.getByRole("list", { name: "This agent's layers" })).toContainText("Reviewer → Role")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.agentWrites.length).toBe(2)
  expect((state.agentWrites[1].body as { promptProfile?: unknown }).promptProfile).toEqual({
    mode: "layers",
    layers: [{ layer: "reviewer", group: "builtin.role" }],
  })
})
