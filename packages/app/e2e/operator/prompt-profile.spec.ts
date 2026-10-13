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

// Picks an option from the select with this accessible name. Records open in a modal overlay, where
// the select's list is not in the accessibility tree, so options are found by their items.
const pick = async (page: Page, label: string, option: string) => {
  await page.locator(`[data-component="select-v2-root"][aria-label="${label}"] [data-component="select-v2"]`).click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: new RegExp(`^${option.replace(/[()]/g, "\\$&")}$`) })
    .click()
}

const user = (id: string, name: string, type: string, section: string, text: string) => ({
  id,
  name,
  type,
  section,
  text,
  origin: "user",
})

test("Layer Definition: a new role layer and an editable copy open in the overlay", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode")
  await expect(page.getByRole("tab", { name: "Layer Definition" })).toHaveAttribute("aria-selected", "true")

  // Only project purposes: the org purpose comes from the namespace, not from a layer here.
  const purpose = page.locator('[data-section="purpose"]')
  await expect(purpose.getByRole("row", { name: /Org purpose/ })).toHaveCount(0)
  await expect(purpose).toContainText("No Project Purposes yet.")
  const messages = page.locator('[data-section="message"]')
  await expect(messages.getByRole("row", { name: /reminder\.plan/ })).toContainText("Sent in the conversation")

  // A new layer opens in the overlay, in edit mode.
  await page.locator('[data-section="role"]').getByRole("button", { name: "New Role" }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("heading", { name: "New Role" })).toBeVisible()
  await overlay.getByLabel("Name", { exact: true }).fill("Reviewer")
  await overlay.getByLabel("Text", { exact: true }).fill("You review release notes.")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({
    method: "POST",
    path: "/operator/namespaces/opencode/layers",
    body: { name: "Reviewer", type: "role", section: "role", text: "You review release notes." },
  })
  // Saved: the layer shows read-only, with Edit.
  await expect(overlay.getByRole("heading", { name: "Reviewer" })).toBeVisible()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  await expect(overlay).toContainText("You review release notes.")
  await overlay.getByRole("button", { name: "Close" }).click()
  await expect(overlay).toBeHidden()
  await expect(page).not.toHaveURL(/layer=/)
  await expect(page.locator('[data-section="role"]').getByRole("row", { name: /Reviewer/ })).toContainText("Yours")

  // OpenCode's text is read-only, with Edit a copy, which opens the copy in edit mode.
  await page
    .locator('[data-section="base"]')
    .getByRole("row", { name: /base\.default/ })
    .click()
  await expect(overlay.locator('[data-component="operator-code"]')).toHaveText(
    "You are opencode, an interactive CLI tool.",
  )
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  await overlay.getByRole("button", { name: "Edit a copy" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(2)
  expect(state.prompt.writes[1].path).toMatch(/\/layers\/opencode(:|%3A)base\.default\/copy$/)
  await expect(overlay.getByRole("heading", { name: "Edit base.default – copy" })).toBeVisible()
  await overlay.getByRole("button", { name: "Cancel" }).click()
  await expect(overlay.getByRole("heading", { name: "base.default – copy" })).toBeVisible()
  await expect(overlay.getByRole("button", { name: "base.default", exact: true })).toBeVisible()

  // Edit brings Cancel; Cancel leaves it unchanged.
  await overlay.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(overlay.getByLabel("Text", { exact: true })).toHaveValue("You are opencode, an interactive CLI tool.")
  await overlay.getByLabel("Text", { exact: true }).fill("Changed.")
  await overlay.getByRole("button", { name: "Cancel" }).click()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toBeVisible()
  await expect(overlay.locator('[data-component="operator-code"]')).toHaveText(
    "You are opencode, an interactive CLI tool.",
  )
  expect(state.prompt.writes).toHaveLength(2)
})

test("the overlay's menu lists a block's records, and ‹ › move through every record on the page", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers&layer=opencode:base.default")
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("heading", { name: "base.default" })).toBeVisible()
  const menu = overlay.getByRole("tablist", { name: "Layer Definition" })
  for (const block of [
    "Base Model Group",
    "Project Purpose",
    "Role",
    "Identity Groups",
    "Dynamic",
    "Helper",
    "Message texts",
  ])
    await expect(menu.getByRole("tab", { name: block })).toBeVisible()
  await expect(menu.getByRole("tab", { name: "Base Model Group" })).toHaveAttribute("aria-selected", "true")

  // The last Base Model Group layer is followed by the first Tool Group layer (Project Purpose, Role
  // and Identity Groups are empty), and the menu follows. There is no Agent prompts block: an agent's
  // own prompt is resolved per agent, and its Prompt tab names its file.
  await expect(menu.getByRole("tab", { name: "Agent prompts" })).toHaveCount(0)
  await overlay.getByRole("button", { name: "Next record" }).click()
  await expect(overlay.getByRole("heading", { name: "tool.read" })).toBeVisible()
  await expect(menu.getByRole("tab", { name: "Tool Group" })).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowLeft")
  await expect(overlay.getByRole("heading", { name: "base.default" })).toBeVisible()

  // A block's records, then one of them.
  await menu.getByRole("tab", { name: "Message texts" }).click()
  const list = overlay.getByRole("list", { name: "Message texts" })
  await expect(list.getByRole("button")).toHaveCount(2)
  await list.getByRole("button", { name: /notice\.max-steps/ }).click()
  await expect(overlay.getByRole("heading", { name: /notice\.max-steps/ })).toBeVisible()
  await expect(page).toHaveURL(/layer=opencode(:|%3A)notice\.max-steps/)

  // An empty block offers its New button.
  await menu.getByRole("tab", { name: "Project Purpose" }).click()
  await expect(overlay).toContainText("No Project Purposes yet.")
  await overlay.getByRole("button", { name: "New Project Purpose" }).click()
  await expect(overlay.getByRole("heading", { name: "New Project Purpose" })).toBeVisible()
  await expect(overlay.getByRole("button", { name: "Next record" })).toHaveCount(0)
  await overlay.getByRole("button", { name: "Cancel" }).click()
  await expect(overlay).toContainText("No Project Purposes yet.")
})

test("Group Definition: a custom type, and a group that orders it with the required types", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=groups")

  const types = page.getByRole("table", { name: "Group types" })
  await expect(types.getByRole("row", { name: /Stable capability boundaries/ })).toContainText("Built-in")
  await page.getByRole("button", { name: "New type" }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Name", { exact: true }).fill("Compliance")
  await overlay.getByLabel("Description", { exact: true }).fill("Rules from legal.")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({
    path: "/operator/namespaces/opencode/types",
    body: { name: "Compliance", description: "Rules from legal." },
  })
  await expect(overlay.getByRole("heading", { name: "Compliance" })).toBeVisible()

  // To Groups through the overlay's menu.
  await overlay.getByRole("tab", { name: "Groups" }).click()
  await overlay.getByRole("button", { name: "New group" }).click()
  await overlay.getByLabel("Name", { exact: true }).fill("Release order")
  const order = overlay.getByRole("list", { name: "Order" })
  await expect(order.getByRole("listitem")).toHaveCount(3)
  await expect(order.getByRole("listitem").first()).toContainText("Required")
  await expect(order.getByRole("button", { name: /Take .* out/ })).toHaveCount(0)
  await pick(page, "Add a type", "Compliance")
  await pick(page, "Add a type", "Output format")
  await order.getByRole("button", { name: "Move Compliance up" }).click()
  await order.getByRole("button", { name: "Take Output format out" }).click()
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
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
  await page.goto("/operator/profile?ns=opencode&tab=profiles")
  await page.getByRole("button", { name: "New profile" }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Name", { exact: true }).fill("Release")

  const purpose = overlay.locator('[data-slot="operator-slot"][data-type="purpose"]')
  await expect(purpose).toContainText("Org purpose (from the namespace)")
  await expect(purpose).toContainText("Locked")
  await expect(purpose.locator('[data-component="select-v2"]')).toHaveCount(0)

  await pick(page, "Add a layer to Agent role", "Reviewer")
  await pick(page, "Add a layer to Agent identity", "Voice")
  await pick(page, "Add a layer to Agent identity", "House rules")
  const identity = overlay.getByRole("list", { name: "Agent identity" })
  await identity.getByRole("button", { name: "Move House rules up" }).click()
  await expect(identity.getByRole("listitem").first()).toContainText("House rules")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({ method: "POST", path: "/operator/namespaces/opencode/profiles" })
  expect(state.prompt.writes[0].body).toMatchObject({
    name: "Release",
    group: "opencode:group.spec",
    slots: { role: ["reviewer"], identity: ["rules", "voice"], platform: [] },
  })

  // Saved: the view keeps the slots' controls (each change there is saved at once), with the
  // profile's actions.
  await expect(overlay.getByRole("heading", { name: "Release" })).toBeVisible()
  await expect(overlay.getByRole("button", { name: "Move House rules up" })).toHaveCount(1)
  await overlay.getByRole("button", { name: "Use as namespace default" }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(2)
  expect(state.prompt.writes[1]).toMatchObject({
    method: "PATCH",
    path: "/operator/namespaces/opencode",
    body: { defaultProfile: "release" },
  })
  await overlay.getByRole("button", { name: "Close" }).click()
  await expect(page.getByRole("row", { name: /Release/ })).toContainText("Namespace default")
})

test("built-in groups and profiles are read-only and can be duplicated; the namespace is in the URL", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "Build tools.", createdAt: 1, updatedAt: 1 })
  state.prompt.items.acme = {
    types: [],
    layers: [user("ship", "Ship tools", "purpose", "purpose", "Ship the tools.")],
    groups: [],
    profiles: [],
  }
  await page.goto("/operator/profile?ns=opencode&tab=groups&group=opencode:group.spec")
  const overlay = page.getByRole("dialog")

  await expect(overlay.getByText("OpenCode's own group.")).toBeVisible()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  await expect(overlay.getByRole("list", { name: "Order" }).getByRole("listitem")).toHaveCount(8)
  await overlay.getByRole("button", { name: "Duplicate" }).click()
  await expect(overlay.getByLabel("Name", { exact: true })).toHaveValue("Default copy")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0].body).toMatchObject({
    types: ["platform", "purpose", "role", "identity", "dynamic", "capabilities", "additional", "output"],
  })
  await overlay.getByRole("button", { name: "Close" }).click()

  await page.goto("/operator/profile?ns=opencode&tab=profiles&profile=opencode:profile.helper.title")
  await expect(overlay.getByText("OpenCode's own profile.")).toBeVisible()
  await expect(overlay.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0)
  await expect(overlay.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
  await expect(overlay.locator('[data-slot="operator-slot"][data-type="helper"]')).toContainText("title")
  await overlay.getByRole("button", { name: "Close" }).click()

  await pick(page, "Namespace", "Acme · acme")
  await expect(page).toHaveURL(/ns=acme/)
  await expect(page).toHaveURL(/tab=profiles/)
  await page.getByRole("tab", { name: "Layer Definition" }).click()
  const purpose = page.locator('[data-section="purpose"]')
  await expect(purpose.getByRole("row")).toHaveCount(2)
  await expect(purpose.getByRole("row", { name: /Ship tools/ })).toContainText("Yours")
})

test("All namespaces: each item's namespace, built-ins in OpenCode and each namespace's own copies, New asks the namespace, and the choice is shared", async ({
  page,
}) => {
  const state = await mockOperator(page)
  state.prompt.namespaces.push({ id: "acme", name: "Acme", purpose: "", createdAt: 1, updatedAt: 1 })
  state.prompt.items.acme = {
    types: [],
    layers: [user("ship", "Ship tools", "purpose", "purpose", "Ship the tools.")],
    groups: [],
    profiles: [],
  }
  state.prompt.items.opencode!.layers.push(user("ship", "Ship goal", "purpose", "purpose", "Ship the goal."))
  await page.goto("/operator/profile")
  const picker = page.locator('[data-component="select-v2-root"][aria-label="Namespace"]')
  await expect(picker).toContainText("All namespaces")

  // The same id in two namespaces: two rows, each with its namespace.
  const purpose = page.locator('[data-section="purpose"]')
  await expect(purpose.getByRole("row")).toHaveCount(3)
  await expect(purpose.getByRole("row", { name: /Ship tools/ })).toContainText("Acme")
  await expect(purpose.getByRole("row", { name: /Ship goal/ })).toContainText("OpenCode")
  // Built-ins belong to OpenCode; Global and Acme have their own copy of each.
  const base = page.locator('[data-section="base"]').getByRole("row", { name: /base\.default/ })
  await expect(base).toHaveCount(3)
  await expect(base.filter({ hasText: "Built in" })).toHaveCount(1)
  await expect(base.filter({ hasText: "Global" })).toHaveCount(1)
  await expect(base.filter({ hasText: "Acme" })).toHaveCount(1)

  await purpose.getByRole("row", { name: /Ship tools/ }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("heading", { name: "Ship tools" })).toBeVisible()
  await expect(overlay).toContainText("Ship the tools.")
  await expect(page).toHaveURL(/rns=acme/)
  await overlay.getByRole("button", { name: "Close" }).click()

  // New asks which namespace.
  await page.locator('[data-section="role"]').getByRole("button", { name: "New Role" }).click()
  await page.getByRole("menuitem", { name: "Acme" }).click()
  await overlay.getByLabel("Name", { exact: true }).fill("Reviewer")
  await overlay.getByLabel("Text", { exact: true }).fill("Review.")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({ method: "POST", path: "/operator/namespaces/acme/layers" })
  await overlay.getByRole("button", { name: "Close" }).click()

  // The namespace choice is shared with Projects until it is changed.
  await page.goto("/operator/projects")
  await expect(picker).toContainText("All namespaces")
  await expect(page.getByRole("row", { name: /smoke-project/ })).toBeVisible()
  await pick(page, "Namespace", "Acme · acme")
  await expect(page.getByRole("row", { name: /smoke-project/ })).toHaveCount(0)
  await page.goto("/operator/profile")
  await expect(picker).toContainText("Acme")
  await expect(page.locator('[data-section="purpose"]').getByRole("row", { name: /Ship goal/ })).toHaveCount(0)
})

test("Dynamic layers show a sample for an agent of a project, and where to change them", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  const dynamic = page.locator('[data-section="dynamic"]')
  await expect(dynamic.getByRole("row", { name: /Environment/ })).toBeVisible()
  await expect(dynamic.getByRole("button", { name: "New Dynamic layer" })).toBeVisible()
  await expect(page.locator('[data-section="role"]').getByRole("columnheader", { name: "Used in" })).toHaveCount(0)
  await dynamic.getByRole("row", { name: /Instructions/ }).click()
  const overlay = page.getByRole("dialog")
  await expect(overlay.locator('[data-slot="record-builtin"]')).toHaveText("Built in")
  await expect(overlay.getByTestId("layer-text-source")).toContainText("Instructions from: <file>")
  await expect(overlay.getByTestId("layer-depends-on")).toHaveText(/Project\s*Config/)
  await overlay.getByRole("button", { name: "Generate sample" }).click()
  await expect(overlay.getByRole("status")).toContainText("Sample for build in smoke-project")
  await expect(overlay.getByRole("status")).toContainText("Use Bun.")
  await expect(overlay.getByTestId("prompt-trace")).toContainText(/Came from\s*Instruction file: .*\/AGENTS\.md/)
  await expect(overlay.getByRole("button", { name: "Open Memory" })).toBeVisible()

  // The base prompt by model points at the layer it comes from.
  await page.goto("/operator/profile?ns=opencode&tab=layers&layer=opencode:slot.base")
  await overlay.getByRole("button", { name: "Generate sample" }).click()
  await expect(overlay.getByRole("status")).toContainText("You are opencode, an interactive CLI tool.")
  await overlay.getByRole("button", { name: "Open base.default" }).click()
  await expect(overlay.getByRole("button", { name: "Edit a copy" })).toBeVisible()
})

test("Agent prompt says where an agent's prompt comes from: a file agent's file, or none for build", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers&layer=opencode:slot.agent")
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByTestId("layer-text-source")).toContainText("only explore has one")
  await expect(overlay.getByTestId("layer-text-source")).toContainText("agents/<name>.md")
  await expect(overlay.getByTestId("layer-depends-on")).toHaveText(/Agent\s*Project\s*Config/)

  // build has no prompt of its own.
  await overlay.getByRole("button", { name: "Generate sample" }).click()
  await expect(overlay.getByTestId("prompt-trace")).toContainText("build has no prompt of its own")

  // Hidden and file agents are offered too, with where they are defined.
  await pick(page, "Agent", "triage (File, Hidden)")
  await overlay.getByRole("button", { name: "Generate sample" }).click()
  await expect(overlay.getByRole("status")).toContainText("Triage issues.")
  await expect(overlay.getByTestId("prompt-trace")).toContainText(/Its agent file: .*\/\.opencode\/agent\/triage\.md/)
})

test("a built-in layer names the file in OpenCode's code its text comes from", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers&layer=opencode:base.default")
  const overlay = page.getByRole("dialog")
  await expect(overlay.locator('[data-slot="record-builtin"]')).toHaveText("Built in")
  await expect(overlay.getByTestId("layer-source-file")).toHaveText("packages/opencode/src/session/prompt/default.txt")
})

test("Prompt Profile has no Size; a profile's Create agent… starts in the project chosen on the operator pages", async ({
  page,
}) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=profiles&profile=opencode:profile.opencode")
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByRole("button", { name: "Create agent…" })).toBeVisible()
  await expect(overlay).not.toContainText("Fixed texts")
  await expect(overlay).not.toContainText("As sent for build")
})

test("a helper profile holds one helper layer, and a helper group no other type", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  await expect(page.locator('[data-section="helper"]').getByRole("row", { name: /title/ })).toBeVisible()
  await expect(page.locator('[data-section="helper"]').getByRole("button", { name: "New Helper" })).toBeVisible()
  await page.goto("/operator/profile?ns=opencode&tab=groups&group=opencode:group.helper")
  const overlay = page.getByRole("dialog")
  await expect(overlay).toContainText("Helper")
})

test("a Dynamic layer of yours is a prompt the dynamic generator writes from", async ({ page }) => {
  const state = await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  await page.locator('[data-section="dynamic"]').getByRole("button", { name: "New Dynamic layer" }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Name", { exact: true }).fill("Release date")
  await expect(overlay.getByLabel("Text", { exact: true })).toHaveCount(0)
  await overlay.getByLabel("Prompt", { exact: true }).fill("Say when the release is.")
  await overlay.getByRole("button", { name: "Save", exact: true }).click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({
    method: "POST",
    path: "/operator/namespaces/opencode/layers",
    body: { name: "Release date", type: "dynamic", section: "dynamic", text: "", prompt: "Say when the release is." },
  })
  await expect(overlay.getByRole("heading", { name: "Release date" })).toBeVisible()
  await expect(overlay).toContainText("Say when the release is.")
  await overlay.getByRole("button", { name: "Generate sample" }).click()
  await expect(overlay.getByRole("status")).toContainText("Written from: Say when the release is.")
  await expect(overlay.getByRole("status")).toContainText("Written now by the dynamic generator")
})

test("the purpose generator drafts a Project Purpose into the editor", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=layers")
  await page.locator('[data-section="purpose"]').getByRole("button", { name: "New Project Purpose" }).click()
  const overlay = page.getByRole("dialog")
  await overlay.getByLabel("Brief", { exact: true }).fill("short")
  await overlay.getByRole("button", { name: "Write a draft" }).click()
  await expect(overlay.getByLabel("Text", { exact: true })).toHaveValue("A drafted project purpose (short).")
})

test("a profile's slots change in its view, and Create agent… makes an agent that uses it", async ({ page }) => {
  const state = await mockOperator(page)
  state.prompt.items.opencode!.layers.push(user("reviewer", "Reviewer", "role", "role", "You review release notes."))
  state.prompt.items.opencode!.profiles.push({
    id: "release",
    name: "Release",
    group: "opencode:group.spec",
    slots: { role: [], dynamic: ["opencode:slot.agent"] },
    builtin: false,
  })
  await page.goto("/operator/profile?ns=opencode&tab=profiles&profile=release")
  const overlay = page.getByRole("dialog")
  await expect(overlay).toContainText("each change is saved at once")

  // A layer added straight from the view is saved.
  await overlay
    .locator('[data-component="select-v2-root"][aria-label="Add a layer to Agent role"] [data-component="select-v2"]')
    .click()
  await page
    .locator('[data-component="menu-v2-item"]')
    .filter({ hasText: /^Reviewer/ })
    .click()
  await expect.poll(() => state.prompt.writes.length).toBe(1)
  expect(state.prompt.writes[0]).toMatchObject({
    method: "PUT",
    path: "/operator/namespaces/opencode/profiles/release",
    body: { name: "Release", slots: { role: ["reviewer"], dynamic: ["opencode:slot.agent"] } },
  })

  await overlay.getByRole("button", { name: "Create agent…" }).click()
  await expect(page).toHaveURL(/\/operator\/agents\/new\?dir=.*&profile=release/)
  await expect(
    page.locator('[data-component="select-v2-root"][aria-label="Profile"] [data-component="select-v2"]'),
  ).toContainText("Release")
  await page.getByLabel("Name", { exact: true }).fill("releaser")
  await page.getByRole("button", { name: "Create agent", exact: true }).click()
  await expect.poll(() => state.agentWrites.length).toBe(1)
  await expect.poll(() => state.prompt.writes.at(-1)?.path).toMatch(/\/operator\/agent-prompt\/releaser$/)
  expect(state.prompt.writes.at(-1)!.body).toMatchObject({ profile: "release" })
})

test("OpenCode's profiles stay read-only in their view", async ({ page }) => {
  await mockOperator(page)
  await page.goto("/operator/profile?ns=opencode&tab=profiles&profile=opencode:profile.spec")
  const overlay = page.getByRole("dialog")
  await expect(overlay.getByText("OpenCode's own profile.")).toBeVisible()
  await expect(overlay.locator('[data-component="select-v2-root"][aria-label^="Add a layer to"]')).toHaveCount(0)
})
