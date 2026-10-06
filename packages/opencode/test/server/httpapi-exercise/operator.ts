// Route scenarios for this fork's endpoints (merge, operator console). Kept out of index.ts so
// upstream changes to the shared scenario list merge without conflicts.
import { Effect } from "effect"
import { array, boolean, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import { type Scenario } from "./types"

// The fork's session guard refuses sessions outside projects; the shared scenarios start sessions in
// plain temporary folders, so the exerciser runs with it off (session-guard.test.ts covers it).
process.env.OPENCODE_PROJECT_GUARD ??= "off"

export const operatorScenarios: Scenario[] = [
  http.protected
    .get("/session/{sessionID}/merge", "session.merge")
    .seeded((ctx) => ctx.session({ title: "Merge session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/merge", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(body === null, "a session that was never merged should have no binding")
    }),
  http.protected.get("/merge/adapter", "merge.adapter.list").json(200, (body) => {
    array(body)
    const claude = body.find((adapter) => isRecord(adapter) && adapter.id === "claude")
    object(claude)
    boolean(claude.enabled)
    boolean(claude.available)
    check(claude.enabled === true, "adapters should be on unless config turns them off")
  }),
  http.protected.get("/operator/config/layer", "operator.config.layers").json(200, (body, ctx) => {
    object(body)
    array(body.sources)
    object(body.targets)
    check(
      typeof body.targets.project === "string" &&
        typeof ctx.directory === "string" &&
        body.targets.project.startsWith(ctx.directory),
      "project writes should target a file inside the project",
    )
  }),
  http.protected
    .patch("/operator/config", "operator.config.update")
    .mutating()
    .at((ctx) => ({
      path: "/operator/config?scope=project",
      headers: ctx.headers(),
      body: { username: "httpapi-operator" },
    }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(body.changed === true, "a new value should be written")
          const text = yield* Effect.promise(() => Bun.file(String(body.path)).text())
          check(text.includes('"username": "httpapi-operator"'), "the patch should be written to the project file")
        }),
      "status",
    ),
  http.protected
    .patch("/operator/config", "operator.config.update.invalid")
    .at((ctx) => ({ path: "/operator/config?scope=project", headers: ctx.headers(), body: { username: 1 } }))
    .status(400),
  http.protected
    .get("/operator/status", "operator.status")
    .global()
    .json(200, (body) => {
      object(body)
      check(typeof body.version === "string", "status should include the version")
      check(typeof body.startedAt === "number" && body.startedAt <= Date.now(), "status should include the start time")
    }),
  http.protected
    .get("/operator/session", "operator.session.list")
    .seeded((ctx) => ctx.session({ title: "Operator session" }))
    .at((ctx) => ({
      path: `/operator/session?directory=${encodeURIComponent(ctx.directory ?? "")}`,
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((session) => isRecord(session) && session.id === ctx.state.id),
        "the seeded session should be listed for its directory",
      )
    }),
  http.protected
    .get("/operator/stats", "operator.stats")
    .global()
    .at(() => ({ path: "/operator/stats?days=3&offset=0" }))
    .json(200, (body) => {
      object(body)
      array(body.days)
      check(body.days.length === 3, "stats should cover the requested days")
      object(body.all)
    }),
  http.protected
    .get("/operator/project", "operator.project.list")
    .global()
    .json(200, (body) => {
      array(body)
      check(
        body.every(
          (project) =>
            isRecord(project) && typeof project.worktree === "string" && typeof project.sessions === "number",
        ),
        "projects should report their worktree and sessions",
      )
    }),
  http.protected.get("/operator/permission", "operator.permission.pending").global().json(200, array),
  http.protected.get("/operator/agent", "operator.agent.list").json(200, (body) => {
    array(body)
    const build = body.find((agent) => isRecord(agent) && agent.name === "build")
    object(build)
    object(build.source)
    check(build.source.kind === "builtin", "build should be a built-in agent")
  }),
  http.protected
    .post("/operator/agent", "operator.agent.create")
    .mutating()
    .at((ctx) => ({
      path: "/operator/agent?scope=project",
      headers: ctx.headers(),
      body: { name: "httpapi-agent", mode: "subagent", description: "From the exerciser", prompt: "Say hi." },
    }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(
            String(body.path).endsWith("/.opencode/agents/httpapi-agent.md"),
            "a project agent file should be written",
          )
          const text = yield* Effect.promise(() => Bun.file(String(body.path)).text())
          check(
            text.includes("description: From the exerciser") && text.includes("Say hi."),
            "the file should hold the agent",
          )
        }),
      "status",
    ),
  http.protected
    .post("/operator/agent", "operator.agent.create.conflict")
    .at((ctx) => ({ path: "/operator/agent?scope=project", headers: ctx.headers(), body: { name: "build" } }))
    .status(409),
  http.protected
    .patch("/operator/agent/{name}", "operator.agent.update")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/agent/{name}", { name: "build" }) + "?scope=project",
      headers: ctx.headers(),
      body: { temperature: 0.4 },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(String(body.path).endsWith("opencode.jsonc"), "a built-in agent's overrides go to the project config")
      },
      "status",
    ),
  http.protected
    .patch("/operator/agent/{name}", "operator.agent.update.missing")
    .at((ctx) => ({
      path: route("/operator/agent/{name}", { name: "no-such-agent" }) + "?scope=project",
      headers: ctx.headers(),
      body: { temperature: 0.4 },
    }))
    .status(404),
  http.protected
    .delete("/operator/agent/{name}", "operator.agent.remove")
    .at((ctx) => ({
      path: route("/operator/agent/{name}", { name: "plan" }) + "?scope=project",
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected.get("/operator/prompt", "operator.prompt.catalog").json(200, (body) => {
    object(body)
    array(body.tools)
    check(
      body.tools.some((item) => isRecord(item) && item.id === "read" && typeof item.builtin === "string"),
      "the catalog should list the read tool with its description",
    )
  }),
  http.protected
    .get("/operator/prompt/preview", "operator.prompt.preview")
    .at((ctx) => ({ path: "/operator/prompt/preview?agent=no-such-agent", headers: ctx.headers() }))
    .status(404),
  http.protected
    .post("/operator/prompt/purpose", "operator.prompt.purpose")
    .at((ctx) => ({ path: "/operator/prompt/purpose", headers: ctx.headers(), body: { kind: "nothing" } }))
    .status(400),
  http.protected
    .get("/operator/prompt/sample", "operator.prompt.sample")
    .at((ctx) => ({
      path: "/operator/prompt/sample?agent=build&layer=no-such-layer",
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected.get("/operator/prompt/plugins", "operator.prompt.plugins").json(200, (body) => {
    object(body)
    array(body.plugins)
  }),
  http.protected.get("/operator/model", "operator.model.defaults").json(200, (body) => {
    object(body)
    object(body.model)
    object(body.small)
    check(typeof body.model.source === "string", "the default model should say where it comes from")
  }),
  http.protected
    .get("/operator/agent/{name}/tool-prompt", "operator.toolPrompt.get")
    .withLlm()
    .at((ctx) => ({
      path: route("/operator/agent/{name}/tool-prompt", { name: "build" }) + "?model=test/test-model",
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.sent)
      array(body.notSent)
      check(
        body.sent.some((item) => isRecord(item) && item.name === "read"),
        "build's tool prompt should send read",
      )
    }),
  http.protected
    .get("/operator/agent/{name}/tool-prompt", "operator.toolPrompt.get.missing")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/tool-prompt", { name: "no-such-agent" }) + "?model=test/test-model",
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/operator/agent/{name}/tool-prompt/draft", "operator.toolPrompt.draft")
    .withLlm()
    .at((ctx) => ({
      path: route("/operator/agent/{name}/tool-prompt/draft", { name: "build" }),
      headers: ctx.headers(),
      body: { model: "test/test-model", agentRules: [{ permission: "webfetch", pattern: "*", action: "deny" }] },
    }))
    .json(200, (body) => {
      object(body)
      object(body.diff)
      array(body.diff.removed)
      check(
        body.diff.removed.some((item) => isRecord(item) && item.name === "webfetch"),
        "denying webfetch should remove it",
      )
    }),
  http.protected
    .get("/operator/agent/{name}/tool-prompt/last", "operator.toolPrompt.last")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/tool-prompt/last", { name: "build" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.captured === "boolean", "Last sent should say whether it was captured")
    }),
  http.protected
    .get("/operator/session/{sessionID}/calls", "operator.call.list")
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/calls", { sessionID: "ses_nocalls" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.calls)
      array(body.exchanges)
      object(body.totals)
    }),
  http.protected
    .get("/operator/session/{sessionID}/calls/export", "operator.call.export")
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/calls/export", { sessionID: "ses_nocalls" }) + "?format=md",
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.text === "string", "the export should be text")
    }),
  http.protected
    .get("/operator/session/{sessionID}/call/{callID}", "operator.call.get")
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/call/{callID}", { sessionID: "ses_nocalls", callID: "call_none" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .get("/operator/session/{sessionID}/call/{callID}/raw", "operator.call.raw")
    .at((ctx) => ({
      path:
        route("/operator/session/{sessionID}/call/{callID}/raw", { sessionID: "ses_nocalls", callID: "call_none" }) +
        "?part=request",
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected.get("/operator/tool", "operator.tool.list").json(200, (body) => {
    array(body)
    check(
      body.some((tool) => isRecord(tool) && tool.id === "read" && tool.origin === "builtin"),
      "read should be listed as a built-in tool",
    )
  }),
  http.protected
    .put("/operator/config/raw", "operator.config.write")
    .mutating()
    .at((ctx) => ({
      path: "/operator/config/raw?scope=project",
      headers: ctx.headers(),
      body: { text: '{\n  // by hand\n  "username": "httpapi-raw"\n}\n' },
    }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          const text = yield* Effect.promise(() => Bun.file(String(body.path)).text())
          check(text.includes("// by hand"), "the raw text should be written as given")
        }),
      "status",
    ),
  http.protected
    .put("/operator/config/raw", "operator.config.write.invalid")
    .at((ctx) => ({ path: "/operator/config/raw?scope=project", headers: ctx.headers(), body: { text: "{ nope" } }))
    .status(400),
  http.protected.get("/operator/config/schema", "operator.config.schema").json(200, (body) => {
    object(body)
    object(body.properties)
    object(body.properties.merge)
  }),
  http.protected.get("/operator/folder/roots", "operator.folder.roots").json(200, (body) => {
    array(body)
    check(body.length > 0 && body.every((root) => typeof root === "string"), "there should be at least one root")
  }),
  http.protected
    .get("/operator/folder", "operator.folder.list")
    .at((ctx) => ({ path: "/operator/folder?path=/", headers: ctx.headers() }))
    .status(403),
  http.protected
    .post("/operator/folder", "operator.folder.create")
    .at((ctx) => ({ path: "/operator/folder", headers: ctx.headers(), body: { parent: "/", name: "..", git: false } }))
    .status(400),
  http.protected
    .post("/operator/folder/init", "operator.folder.init")
    .at((ctx) => ({ path: "/operator/folder/init", headers: ctx.headers(), body: { path: "/" } }))
    .status(403),
  http.protected.get("/operator/memory/overview", "operator.memory.overview").json(200, (body) => {
    object(body)
    array(body.files)
    object(body.database)
    array(body.database.tables)
    check(
      body.database.tables.some((table) => isRecord(table) && table.name === "session"),
      "the session table should be counted",
    )
  }),
  http.protected
    .get("/operator/memory/file", "operator.memory.read")
    .at((ctx) => ({ path: "/operator/memory/file?path=/etc/hostname", headers: ctx.headers() }))
    .status(403),
  http.protected
    .put("/operator/memory/file", "operator.memory.write")
    .mutating()
    .at((ctx) => ({
      path: "/operator/memory/file",
      headers: ctx.headers(),
      body: { path: `${ctx.directory}/AGENTS.md`, text: "Written by the exerciser.\n" },
    }))
    .json(200, (body) => check(body === true, "AGENTS.md at the project root should be created"), "status"),
  http.protected.get("/operator/namespaces", "operator.namespace.list").json(200, (body) => {
    array(body)
    check(
      isRecord(body[0]) && isRecord(body[0].namespace) && body[0].namespace.id === "opencode",
      "OpenCode should be the first namespace",
    )
  }),
  http.protected
    .post("/operator/namespaces", "operator.namespace.create")
    .mutating()
    .at((ctx) => ({
      path: "/operator/namespaces",
      headers: ctx.headers(),
      body: { name: "HttpApi team", purpose: "Test." },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.id === "httpapi-team" && body.purpose === "Test.", "the namespace should be created")
      },
      "status",
    ),
  http.protected
    .get("/operator/namespaces/{ns}", "operator.namespace.get")
    .at((ctx) => ({ path: route("/operator/namespaces/{ns}", { ns: "opencode" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.id === "opencode" && body.name === "OpenCode", "OpenCode should exist from the start")
    }),
  http.protected
    .patch("/operator/namespaces/{ns}", "operator.namespace.update")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { purpose: "" },
    }))
    .json(200, (body) => check(isRecord(body) && body.purpose === "", "the purpose should be saved"), "status"),
  http.protected
    .delete("/operator/namespaces/{ns}", "operator.namespace.remove")
    .at((ctx) => ({ path: route("/operator/namespaces/{ns}", { ns: "opencode" }), headers: ctx.headers() }))
    .status(400),
  http.protected
    .get("/operator/namespaces/{ns}/catalog", "operator.namespace.catalog")
    .at((ctx) => ({ path: route("/operator/namespaces/{ns}/catalog", { ns: "opencode" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.profiles)
      array(body.types)
      check(
        body.profiles.some((item) => isRecord(item) && item.id === "opencode:profile.opencode"),
        "the built-in OpenCode profile should be listed",
      )
      check(body.types.length >= 7, "the seven built-in group types should be listed")
    }),
  http.protected
    .post("/operator/namespaces/{ns}/types", "operator.namespace.type.create")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/types", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { name: "HttpApi rules", description: "Rules" },
    }))
    .json(200, (body) => check(isRecord(body) && body.builtin === false, "the type should be saved"), "status"),
  http.protected
    .put("/operator/namespaces/{ns}/types/{id}", "operator.namespace.type.update")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/types/{id}", { ns: "opencode", id: "missing" }),
      headers: ctx.headers(),
      body: { name: "x" },
    }))
    .status(404),
  http.protected
    .delete("/operator/namespaces/{ns}/types/{id}", "operator.namespace.type.remove")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/types/{id}", { ns: "opencode", id: "role" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/operator/namespaces/{ns}/layers", "operator.namespace.layer.create")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/layers", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { name: "HttpApi role", type: "role", section: "role", text: "You check the API." },
    }))
    .json(
      200,
      (body) => check(isRecord(body) && body.type === "role" && body.origin === "user", "the layer should be saved"),
      "status",
    ),
  http.protected
    .put("/operator/namespaces/{ns}/layers/{id}", "operator.namespace.layer.update")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/layers/{id}", { ns: "opencode", id: "missing" }),
      headers: ctx.headers(),
      body: { name: "x", type: "role", text: "x" },
    }))
    .status(404),
  http.protected
    .delete("/operator/namespaces/{ns}/layers/{id}", "operator.namespace.layer.remove")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/layers/{id}", {
        ns: "opencode",
        id: encodeURIComponent("opencode:base.gemini"),
      }),
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/operator/namespaces/{ns}/layers/{id}/copy", "operator.namespace.layer.copy")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/layers/{id}/copy", {
        ns: "opencode",
        id: encodeURIComponent("opencode:base.gemini"),
      }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(
      200,
      (body) =>
        check(
          isRecord(body) && body.replaces === "opencode:base.gemini" && body.type === "identity",
          "the copy should keep its type",
        ),
      "status",
    ),
  http.protected
    .post("/operator/namespaces/{ns}/groups", "operator.namespace.group.create")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/groups", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { name: "No role", types: ["purpose", "identity"] },
    }))
    .status(400),
  http.protected
    .put("/operator/namespaces/{ns}/groups/{id}", "operator.namespace.group.update")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/groups/{id}", {
        ns: "opencode",
        id: encodeURIComponent("opencode:group.spec"),
      }),
      headers: ctx.headers(),
      body: { name: "Default", types: ["purpose", "role", "identity"] },
    }))
    .status(400),
  http.protected
    .delete("/operator/namespaces/{ns}/groups/{id}", "operator.namespace.group.remove")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/groups/{id}", { ns: "opencode", id: "missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/operator/namespaces/{ns}/profiles", "operator.namespace.profile.create")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/profiles", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { name: "Bad", group: "opencode:group.spec", slots: { purpose: ["opencode:purpose.org"] } },
    }))
    .status(400),
  http.protected
    .put("/operator/namespaces/{ns}/profiles/{id}", "operator.namespace.profile.update")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/profiles/{id}", {
        ns: "opencode",
        id: encodeURIComponent("opencode:profile.opencode"),
      }),
      headers: ctx.headers(),
      body: { name: "OpenCode", group: "opencode:group.opencode", slots: {} },
    }))
    .status(400),
  http.protected
    .delete("/operator/namespaces/{ns}/profiles/{id}", "operator.namespace.profile.remove")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/profiles/{id}", { ns: "opencode", id: "missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/operator/namespaces/{ns}/layers/{id}/sync", "operator.namespace.layer.sync")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/layers/{id}/sync", { ns: "opencode", id: "missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/operator/namespaces/{ns}/copy", "operator.namespace.copy")
    .at((ctx) => ({
      path: route("/operator/namespaces/{ns}/copy", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { kind: "profile", id: "missing", target: "opencode" },
    }))
    .status(400),
  http.protected.get("/operator/project-settings", "operator.projectSettings.list").json(200, array),
  http.protected.get("/operator/trash", "operator.trash.list").json(200, array),
  http.protected
    .post("/operator/trash/project", "operator.trash.project")
    .at((ctx) => ({ path: "/operator/trash/project", headers: ctx.headers(), body: { key: "/" } }))
    .status(400),
  http.protected
    .post("/operator/trash/session", "operator.trash.session")
    .at((ctx) => ({ path: "/operator/trash/session", headers: ctx.headers(), body: { sessionID: "ses_missing" } }))
    .status(400),
  http.protected
    .post("/operator/trash/{id}/restore", "operator.trash.restore")
    .at((ctx) => ({ path: route("/operator/trash/{id}/restore", { id: "missing" }), headers: ctx.headers() }))
    .status(400),
  http.protected
    .delete("/operator/trash/{id}", "operator.trash.purge")
    .at((ctx) => ({ path: route("/operator/trash/{id}", { id: "missing" }), headers: ctx.headers() }))
    .status(400),
  http.protected.delete("/operator/trash", "operator.trash.empty").json(200, object),
  http.protected
    .post("/operator/trash/item", "operator.trash.item")
    .at((ctx) => ({ path: "/operator/trash/item", headers: ctx.headers(), body: { kind: "skill", name: "missing" } }))
    .status(400),
  http.protected
    .put("/operator/project-settings", "operator.projectSettings.update")
    .at((ctx) => ({
      path: "/operator/project-settings",
      headers: ctx.headers(),
      body: { key: ctx.directory ?? "/tmp/x", namespace: "missing" },
    }))
    .status(404),
  http.protected
    .get("/operator/project-settings/resolve", "operator.projectSettings.resolve")
    .at((ctx) => ({
      path: `/operator/project-settings/resolve?directory=${encodeURIComponent(ctx.directory ?? "/tmp")}`,
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.directory === "string", "the folder should come back resolved")
    }),
  http.protected
    .post("/operator/project-settings/register", "operator.projectSettings.register")
    .at((ctx) => ({
      path: "/operator/project-settings/register",
      headers: ctx.headers(),
      body: { directory: ctx.directory ?? "/tmp/x", namespace: "missing" },
    }))
    .status(400),
  http.protected
    .post("/operator/project-settings/folder/move", "operator.folderSessions.move")
    .at((ctx) => ({
      path: "/operator/project-settings/folder/move",
      headers: ctx.headers(),
      body: { directory: ctx.directory ?? "/tmp/x", project: ctx.directory ?? "/tmp/x" },
    }))
    .status(400),
  http.protected
    .post("/operator/project-settings/folder/archive", "operator.folderSessions.archive")
    .at((ctx) => ({
      path: "/operator/project-settings/folder/archive",
      headers: ctx.headers(),
      body: { directory: ctx.directory ?? "/tmp/x" },
    }))
    .status(400),
  http.protected
    .get("/operator/agent-prompt/{name}", "operator.agentPrompt.get")
    .at((ctx) => ({ path: route("/operator/agent-prompt/{name}", { name: "build" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      object(body.profile)
      check(
        body.profile.id === "opencode:profile.opencode" && body.profile.source === "namespace",
        "build should use the OpenCode profile",
      )
    }),
  http.protected
    .put("/operator/agent-prompt/{name}", "operator.agentPrompt.update")
    .at((ctx) => ({
      path: route("/operator/agent-prompt/{name}", { name: "build" }),
      headers: ctx.headers(),
      body: { profile: "missing" },
    }))
    .status(400),
]
