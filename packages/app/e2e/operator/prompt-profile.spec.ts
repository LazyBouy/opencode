import { expect, type Page, test } from "@playwright/test"
import { fixture, pageMessages } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { mockOperator } from "./mock-operator"

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

// Picks an option from the select with this accessible name.
const pick = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

const user = (id: string, name: string, type: string, section: string, text: string) => ({
  id,
  name,
  type,
  section,
  text,
  origin: "user",
})

test("Layer Definition: sections, a new role layer and an editable copy of a built-in text", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile")
  await expect(page.getByRole("tab", { name: "Layer Definition" })).toHaveAttribute("aria-selected", "true")

  const purpose = page.locator('[data-section="purpose"]')
  await expect(purpose.getByRole("heading", { name: "Project Purpose" })).toBeVisible()
  await expect(purpose.getByRole("row", { name: /Org purpose/ })).toBeVisible()
  const messages = page.locator('[data-section="message"]')
  await expect(messages.getByRole("row", { name: /reminder\.plan/ })).toContainText("Sent in the conversation")

  await page.locator('[data-section="role"]').getByRole("button", { name: "New layer" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Reviewer")
  await page.getByLabel("Text", { exact: true }).fill("You review release notes.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({
    method: "POST",
    path: "/operator/namespaces/opencode/layers",
    body: { name: "Reviewer", type: "role", section: "role", text: "You review release notes." },
  })
  await expect(page.locator('[data-section="role"]').getByRole("row", { name: /Reviewer/ })).toContainText("Yours")

  await page
    .locator('[data-section="base"]')
    .getByRole("row", { name: /base\.default/ })
    .click()
  await expect(page.locator('[data-slot="operator-sticky"] [data-component="operator-code"]')).toHaveText(
    "You are opencode, an interactive CLI tool.",
  )
  await page.getByRole("button", { name: "Make editable copy" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(2)
  expect(state.prompt.writes[1].path).toMatch(/\/layers\/opencode(:|%3A)base\.default\/copy$/)
  await expect(page.getByLabel("Text", { exact: true })).toHaveValue("You are opencode, an interactive CLI tool.")
  await expect(page.getByText("Editable copy of")).toBeVisible()
  await expect(page.locator('[data-section="base"]').getByRole("row", { name: /base\.default – copy/ })).toContainText(
    "Copy of base.default",
  )
})

test("Group Definition: a custom type, and a group that orders it with the required types", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?tab=groups")

  const types = page.getByRole("table", { name: "Group types" })
  await expect(types.getByRole("row", { name: /Stable capability boundaries/ })).toContainText("Built-in")
  await page.getByRole("button", { name: "New type" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Compliance")
  await page.getByLabel("Description", { exact: true }).fill("Rules from legal.")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({
    path: "/operator/namespaces/opencode/types",
    body: { name: "Compliance", description: "Rules from legal." },
  })

  await page.getByRole("button", { name: "New group" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Release order")
  const order = page.getByRole("list", { name: "Order" })
  await expect(order.getByRole("listitem")).toHaveCount(3)
  await expect(order.getByRole("listitem").first()).toContainText("Required")
  await expect(order.getByRole("button", { name: /Take .* out/ })).toHaveCount(0)
  await pick(page, "Add a type", "Compliance")
  await pick(page, "Add a type", "Output format")
  await order.getByRole("button", { name: "Move Compliance up" }).click()
  await order.getByRole("button", { name: "Take Output format out" }).click()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(2)
  expect(state.prompt.writes[1]).toMatchObject({
    method: "POST",
    path: "/operator/namespaces/opencode/groups",
    body: { name: "Release order", types: ["purpose", "role", "compliance", "identity"] },
  })
})

test("Profile Definition: layers in two slots, reordered, and the profile made the namespace default", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.items.opencode!.layers.push(
    user("reviewer", "Reviewer", "role", "role", "You review."),
    user("voice", "Voice", "identity", "identity", "Speak plainly."),
    user("rules", "House rules", "identity", "identity", "Use Bun."),
  )
  await page.goto("/operator/profile?tab=profiles")
  await page.getByRole("button", { name: "New profile" }).click()
  await page.getByLabel("Name", { exact: true }).fill("Release")

  const purpose = page.locator('[data-slot="operator-slot"][data-type="purpose"]')
  await expect(purpose).toContainText("Org purpose (from the namespace)")
  await expect(purpose).toContainText("Locked")
  await expect(purpose.locator('[data-component="select-v2"]')).toHaveCount(0)

  await pick(page, "Add a layer to Agent role", "Reviewer")
  await pick(page, "Add a layer to Agent identity", "Voice")
  await pick(page, "Add a layer to Agent identity", "House rules")
  const identity = page.getByRole("list", { name: "Agent identity" })
  await identity.getByRole("button", { name: "Move House rules up" }).click()
  await expect(identity.getByRole("listitem").first()).toContainText("House rules")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({ method: "POST", path: "/operator/namespaces/opencode/profiles" })
  expect(state.prompt.writes[0].body).toMatchObject({
    name: "Release",
    group: "opencode:group.spec",
    slots: { role: ["reviewer"], identity: ["rules", "voice"], platform: [] },
  })

  await page.getByRole("button", { name: "Use as namespace default" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(2)
  expect(state.prompt.writes[1]).toMatchObject({
    method: "PATCH",
    path: "/operator/namespaces/opencode",
    body: { defaultProfile: "release" },
  })
  await expect(page.getByRole("row", { name: /Release/ })).toContainText("Namespace default")
})

test("built-in groups and profiles are read-only and can be duplicated; the namespace is in the URL", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "Build tools.", createdAt: 1, updatedAt: 1 })
  state.prompt.items.acme = { types: [], layers: [], groups: [], profiles: [] }
  await page.goto("/operator/profile?tab=groups&group=opencode:group.spec")

  await expect(page.getByText("OpenCode's own group.")).toBeVisible()
  await expect(page.getByRole("list", { name: "Order" }).getByRole("listitem")).toHaveCount(7)
  await page.getByRole("button", { name: "Duplicate" }).click()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Default copy")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0].body).toMatchObject({
    types: ["platform", "purpose", "role", "identity", "capabilities", "additional", "output"],
  })

  await page.goto("/operator/profile?tab=profiles&profile=opencode:profile.helper")
  await expect(page.getByText("OpenCode's own profile.")).toBeVisible()
  await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
  await expect(page.locator('[data-slot="operator-slot"][data-type="identity"]')).toContainText(
    "Agent prompt, else base prompt",
  )

  await pick(page, "Namespace", "Acme")
  await expect(page).toHaveURL(/ns=acme/)
  await expect(page).toHaveURL(/tab=profiles/)
  await page.getByRole("tab", { name: "Layer Definition" }).click()
  await page
    .locator('[data-section="purpose"]')
    .getByRole("row", { name: /Org purpose/ })
    .click()
  await expect(page.locator('[data-slot="operator-sticky"]')).toContainText("Build tools.")
})
