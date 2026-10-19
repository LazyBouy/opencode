// Route scenarios for this fork's endpoints (merge, operator console). Kept out of index.ts so
// upstream changes to the shared scenario list merge without conflicts.
import os from "os"
import { Effect } from "effect"
import { array, boolean, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import { type Scenario } from "./types"

// The fork's session guard refuses sessions outside projects; the shared scenarios start sessions in
// plain temporary folders, so the exerciser runs with it off (session-guard.test.ts covers it).
process.env.OPENCODE_PROJECT_GUARD ??= "off"
// Namespace folders must be inside the workspace roots; the exerciser creates them in the temp folder.
process.env.OPENCODE_WORKSPACE_ROOTS ??= os.tmpdir()

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
      // A project without a config of its own gets a copy of its namespace's: that needs confirmCopy.
      path: "/operator/config?scope=project&confirmCopy=true",
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
    .at((ctx) => ({
      path: "/operator/config?scope=project&confirmCopy=true",
      headers: ctx.headers(),
      body: { username: 1 },
    }))
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
  http.protected
    .post("/operator/permission/{requestID}/decide", "operator.permission.decide")
    .global()
    .at((ctx) => ({
      path: route("/operator/permission/{requestID}/decide", { requestID: "per_missing" }),
      headers: ctx.headers(),
      body: { decision: "allow", via: "inbox" },
    }))
    // Answered already, or never asked: no longer waiting (permission-decide.test.ts covers the choices).
    .status(409),
  http.protected
    .get("/operator/permission/decision", "operator.permission.decisions")
    .global()
    .at((ctx) => ({ path: "/operator/permission/decision?limit=20", headers: ctx.headers() }))
    .json(200, array),
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
      // The project gets its own copy of its namespace's config: that needs confirmCopy.
      path: route("/operator/agent/{name}", { name: "build" }) + "?scope=project&confirmCopy=true",
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
  // Moving an agent (agent_form_spec.md §7): a built-in agent is part of every project.
  http.protected
    .post("/operator/agent/{name}/move", "operator.agent.move")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/move", { name: "build" }),
      headers: ctx.headers(),
      body: { project: "/tmp/elsewhere" },
    }))
    .status(400),
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
  // The agent form's preview (agent_form_spec.md §6.2): an agent not saved yet, with its typed prompt.
  http.protected
    .post("/operator/prompt/preview", "operator.prompt.previewDraft")
    .at((ctx) => ({
      path: "/operator/prompt/preview",
      headers: ctx.headers(),
      body: { agent: "httpapi-draft", draft: { prompt: "Draft prompt text.", mode: "subagent" } },
    }))
    .json(200, (body) => {
      object(body)
      check(body.agent === "httpapi-draft", "the draft agent is previewed")
      check(
        Array.isArray(body.system) && (body.system as string[]).join("\n").includes("Draft prompt text."),
        "its typed prompt is in the system prompt",
      )
    }),
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
    object(body.chain)
    check(
      isRecord(body.chain.model) && Array.isArray(body.chain.model.levels),
      "the default model's chain should list its levels",
    )
  }),
  // The default and small model by level (default_models_spec.md §11). Writes would change every later
  // scenario's models: only refusals are exercised; writing is tested in test/operator/model-chain.test.ts.
  http.protected.get("/operator/model/namespace", "operator.model.namespace").json(200, (body) => {
    object(body)
    check(body.settings === true, "without a namespace the chain is Settings'")
    object(body.chain)
  }),
  http.protected
    .put("/operator/model/default", "operator.model.write")
    .at((ctx) => ({
      path: "/operator/model/default",
      headers: ctx.headers(),
      body: { level: "namespace", key: "model", model: null },
    }))
    .status(400),
  http.protected
    .get("/operator/model/default-for", "operator.model.defaultFor")
    .at((ctx) => ({ path: "/operator/model/default-for?model=test/none", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.namespaces)
      array(body.projects)
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
    .get("/operator/agent/{name}/session-state", "operator.agentSessions.state")
    .at((ctx) => ({ path: route("/operator/agent/{name}/session-state", { name: "build" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.agent === "build", "the state should name the agent")
    }),
  http.protected
    .get("/operator/agent/{name}/session-state", "operator.agentSessions.state.missing")
    .at((ctx) => ({ path: route("/operator/agent/{name}/session-state", { name: "missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .put("/operator/agent/{name}/main", "operator.agentSessions.setMain")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/agent/{name}/main", { name: "build" }),
      headers: ctx.headers(),
      body: { sessionID: "" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.main === undefined, "an empty session clears the main session")
    }),
  http.protected
    .post("/operator/main-session", "operator.agentSessions.mainSession")
    .mutating()
    .at((ctx) => ({ path: "/operator/main-session?agent=build", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      object(body.session)
      check(typeof body.session.id === "string", "the main session should be made")
    }),
  http.protected
    .put("/operator/agent/{name}/target", "operator.agentSessions.setTarget")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/agent/{name}/target", { name: "build" }),
      headers: ctx.headers(),
      body: { target: "active" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.target === "active", "the default target should be saved")
    }),
  http.protected
    .post("/operator/agent/{name}/queue", "operator.queue.send")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Queue session" })
        yield* ctx.llmText("fake queued assistant")
        yield* ctx.llmText("fake queued assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/operator/agent/{name}/queue", { name: "build" }),
      headers: ctx.headers(),
      body: { text: "hello from the queue", sessionID: ctx.state.id },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.target === "session" && body.sessionID === ctx.state.id, "the message should name its session")
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/operator/agent/{name}/queue", "operator.queue.send.empty")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/queue", { name: "build" }),
      headers: ctx.headers(),
      body: { text: " " },
    }))
    .status(400),
  http.protected
    .get("/operator/agent/{name}/queue", "operator.queue.agent")
    .at((ctx) => ({ path: route("/operator/agent/{name}/queue", { name: "build" }), headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/operator/queue", "operator.queue.list")
    .at((ctx) => ({ path: "/operator/queue?status=queued&limit=10", headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .delete("/operator/queue/{id}", "operator.queue.cancel")
    .at((ctx) => ({ path: route("/operator/queue/{id}", { id: "qm_missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .get("/operator/agent/{name}/permissions", "operator.agentPermissions.get")
    .at((ctx) => ({ path: route("/operator/agent/{name}/permissions", { name: "build" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.rows)
      check(
        body.rows.some((row) => isRecord(row) && isRecord(row.from) && row.from.kind === "opencode-default"),
        "rows should say where each rule comes from",
      )
      object(body.targets)
    }),
  http.protected
    .get("/operator/agent/{name}/permission-locks", "operator.agentPermissions.locks")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/permission-locks", { name: "build" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.locks)
      check(body.inherit === "own", "an agent checks its own locks unless set otherwise")
    }),
  http.protected
    .put("/operator/agent/{name}/permission-locks", "operator.agentPermissions.saveLocks")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/permission-locks", { name: "build" }),
      headers: ctx.headers(),
      body: { locks: [{ permission: "bash", pattern: "*" }], inherit: "own" },
    }))
    .json(200, (body) => {
      object(body)
      array(body.locks)
      check(body.locks.length === 1, "the lock should be kept")
    }),
  http.protected
    .get("/operator/agent/{name}/permissions", "operator.agentPermissions.get.missing")
    .at((ctx) => ({ path: route("/operator/agent/{name}/permissions", { name: "missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .put("/operator/agent/{name}/permissions", "operator.agentPermissions.save")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/agent/{name}/permissions", { name: "build" }) + "?confirmCopy=true",
      headers: ctx.headers(),
      body: { scope: "project", rules: [{ permission: "webfetch", pattern: "*", action: "deny" }] },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(String(body.path).endsWith("opencode.jsonc"), "a built-in agent's rules go to the project config")
      },
      "status",
    ),
  http.protected
    .put("/operator/agent/{name}/permissions", "operator.agentPermissions.save.duplicate")
    .at((ctx) => ({
      path: route("/operator/agent/{name}/permissions", { name: "build" }),
      headers: ctx.headers(),
      body: {
        scope: "project",
        rules: [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "read", pattern: "*", action: "deny" },
        ],
      },
    }))
    .status(400),
  http.protected
    .get("/operator/permission/level/{level}", "operator.permissionLevel.get")
    .at((ctx) => ({ path: route("/operator/permission/level/{level}", { level: "project" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.rows)
      array(body.own)
      check(
        body.rows.some((row) => isRecord(row) && row.level === "opencode"),
        "a project inherits OpenCode's lines",
      )
      check(body.canDeleteOpenCode === false, "OpenCode's lines stay in the OpenCode namespace")
    }),
  http.protected
    .put("/operator/permission/level/{level}", "operator.permissionLevel.save")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/permission/level/{level}", { level: "project" }) + "?confirmCopy=true",
      headers: ctx.headers(),
      body: { lines: [{ permission: "webfetch", pattern: "*", action: "deny" }], deleted: [], locks: [] },
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.own)
        check(
          body.own.some((row) => isRecord(row) && row.permission === "webfetch" && row.action === "deny"),
          "the project's line is written",
        )
      },
      "status",
    ),
  http.protected
    .put("/operator/permission/level/{level}", "operator.permissionLevel.save.protected")
    .at((ctx) => ({
      path: route("/operator/permission/level/{level}", { level: "project" }),
      headers: ctx.headers(),
      body: { lines: [], deleted: [{ permission: "*", pattern: "*" }], locks: [] },
    }))
    .status(409),
  http.protected
    .get("/operator/session/{sessionID}/permissions", "operator.sessionPermissions.get")
    .seeded((ctx) => ctx.session({ title: "Permission session" }))
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/permissions", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.rows)
      array(body.written)
      check(body.written.length === 0, "a new session has no rules of its own")
    }),
  http.protected
    .get("/operator/session/{sessionID}/permissions", "operator.sessionPermissions.get.missing")
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/permissions", { sessionID: "ses_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .put("/operator/session/{sessionID}/permissions", "operator.sessionPermissions.save")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Permission session" }))
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/permissions", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { rules: [{ permission: "webfetch", pattern: "*", action: "deny" }] },
    }))
    .json(200, (body) => {
      object(body)
      array(body.written)
      check(body.written.length === 1, "the session's rule should be saved")
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
      array(body.turns)
      object(body.session)
      array(body.session.rows)
      array(body.unrecorded)
    }),
  http.protected
    .post("/operator/session/{sessionID}/calls/recount", "operator.call.recount")
    .mutating()
    .at((ctx) => ({
      path: route("/operator/session/{sessionID}/calls/recount", { sessionID: "ses_nocalls" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(body.ok === true, "a recount should be accepted")
    }),
  http.protected.get("/operator/tokenizers", "operator.call.tokenizers").json(200, (body) => {
    object(body)
    array(body.tokenizers)
    array(body.errors)
    check(typeof body.folder === "string", "the tokenizer folder should be named")
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
  http.protected.get("/operator/config/resolved", "operator.config.resolved").json(200, (body) => {
    object(body)
    check(body.mode === "own" || body.mode === "namespace", "the project uses its own config or its namespace's")
    check(typeof body.file === "string" && typeof body.text === "string", "the config's file and text")
    array(body.ownFiles)
    array(body.subfolderFiles)
  }),
  http.protected
    .put("/operator/config/project", "operator.config.project")
    .mutating()
    .at((ctx) => ({
      path: "/operator/config/project?confirmCopy=true",
      headers: ctx.headers(),
      body: { text: '{\n  // by hand\n  "username": "httpapi-raw"\n}\n' },
    }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          const text = yield* Effect.promise(() => Bun.file(String(body.path)).text())
          check(text.includes("// by hand"), "the text should be written as given")
        }),
      "status",
    ),
  http.protected
    .put("/operator/config/project", "operator.config.project.invalid")
    .at((ctx) => ({
      path: "/operator/config/project?confirmCopy=true",
      headers: ctx.headers(),
      body: { text: "{ nope" },
    }))
    .status(400),
  http.protected.get("/operator/config/compare", "operator.config.compare").json(200, (body) => {
    object(body)
    object(body.project)
    object(body.namespace)
  }),
  http.protected
    .post("/operator/config/project/revert", "operator.config.revert")
    .mutating()
    .seeded((ctx) => ctx.file("opencode.json", "{}\n"))
    .at((ctx) => ({ path: "/operator/config/project/revert", headers: ctx.headers() }))
    .json(
      200,
      (body) => check(isRecord(body) && typeof body.trash === "string", "the config should go to Trash"),
      "status",
    ),
  http.protected
    .get("/operator/namespace/{id}/config", "operator.namespaceConfig.get")
    .at((ctx) => ({ path: route("/operator/namespace/{id}/config", { id: "opencode" }), headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(typeof body.file === "string" && typeof body.global === "boolean", "the namespace's config file")
      array(body.using)
      array(body.own)
    }),
  http.protected
    .get("/operator/namespace/{id}/config/effective", "operator.namespaceConfig.effective")
    .at((ctx) => ({
      path: route("/operator/namespace/{id}/config/effective", { id: "global" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      object(body.config)
      object(body.origins)
      array(body.sources)
      check(typeof body.folder === "string", "the folder the config was loaded at")
    }),
  // A valid save would change Global's config for every later scenario: only the refusal is exercised.
  http.protected
    .put("/operator/namespace/{id}/config", "operator.namespaceConfig.save")
    .at((ctx) => ({
      path: route("/operator/namespace/{id}/config", { id: "opencode" }),
      headers: ctx.headers(),
      body: { text: '{ "username": 3 }' },
    }))
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
  http.protected.get("/operator/memory/settings", "operator.memory.settings").json(200, (body) => {
    object(body)
    check(body.commit === false, ".memory folders should not be committed by default")
    check(
      body.indexLines === 200 && body.indexChars === 25000,
      "the index limits should default to 200 lines, 25,000 characters",
    )
    array(body.projects)
  }),
  http.protected
    .put("/operator/memory/settings", "operator.memory.saveSettings")
    .at((ctx) => ({ path: "/operator/memory/settings", headers: ctx.headers(), body: { indexLines: 0 } }))
    .status(403),
  http.protected.get("/operator/memory/levels", "operator.memory.levels").json(200, (body) => {
    object(body)
    array(body.levels)
    check(body.levels.length === 3, "the namespace, project and agent levels should be listed")
    check(body.agent === "build", "the agent level should be build's unless an agent is named")
  }),
  http.protected
    .get("/operator/memory/entry", "operator.memory.entry")
    .at((ctx) => ({ path: "/operator/memory/entry?level=project&file=..%2Fescape.md", headers: ctx.headers() }))
    .status(400),
  http.protected
    .put("/operator/memory/entry", "operator.memory.saveEntry")
    .mutating()
    .at((ctx) => ({
      path: "/operator/memory/entry",
      headers: ctx.headers(),
      body: { level: "project", title: "Exerciser note", description: "Saved by the exerciser", content: "A memory." },
    }))
    .json(200, (body) => {
      object(body)
      check(body.file === "exerciser-note.md", "the memory's file should be a slug of its title")
    }),
  http.protected
    .delete("/operator/memory/entry", "operator.memory.forgetEntry")
    .at((ctx) => ({ path: "/operator/memory/entry?level=project&file=no-such-memory.md", headers: ctx.headers() }))
    .status(400),
  http.protected
    .put("/operator/memory/index", "operator.memory.writeIndex")
    .mutating()
    .at((ctx) => ({
      path: "/operator/memory/index",
      headers: ctx.headers(),
      body: { level: "agent", text: "- [A](a.md) — One\nA note by hand\n" },
    }))
    .json(200, (body) => {
      object(body)
      array(body.invalid)
      check(body.invalid.length === 1, "the hand-written line should be kept and flagged")
    }),
  http.protected.get("/operator/capability/tool-patterns", "operator.capability.toolPatterns").json(200, (body) => {
    array(body)
    const bash = body.find((item) => isRecord(item) && item.tool === "bash")
    check(isRecord(bash) && bash.permission === "bash" && bash.form === "command", "bash should ask with its command")
    check(
      body.some((item) => isRecord(item) && item.tool === "external_directory"),
      "paths outside the project should be listed",
    )
  }),
  http.protected
    .put("/operator/capability/tool-pattern", "operator.capability.saveToolPattern")
    .at((ctx) => ({
      path: "/operator/capability/tool-pattern",
      headers: ctx.headers(),
      body: { tool: "bash", permission: "bash", verbs: [], text: "*", examples: [] },
    }))
    .status(400),
  http.protected.get("/operator/layout", "operator.layout.get").json(200, (body) => {
    object(body)
    array(body.namespaces)
    array(body.flagged)
    check(typeof body.merged === "boolean", "the layout should say whether Global and OpenCode are one")
    check(
      body.namespaces.some((item) => isRecord(item) && item.global === true),
      "Global (or Global · OpenCode) should be in the layout",
    )
  }),
  // Setting it would split Global and OpenCode for every later scenario: only the refusal is exercised.
  http.protected
    .put("/operator/layout/working-dir", "operator.layout.workingDir")
    .at((ctx) => ({
      path: "/operator/layout/working-dir",
      headers: ctx.headers(),
      body: { workingDir: "relative/dir" },
    }))
    .status(400),
  // Moving folders: only refusals are exercised (a real move changes folders for every later scenario).
  http.protected
    .post("/operator/layout/plan", "operator.layout.plan")
    .at((ctx) => ({
      path: "/operator/layout/plan",
      headers: ctx.headers(),
      body: { kind: "namespace", namespace: "opencode" },
    }))
    .status(400),
  http.protected
    .post("/operator/layout/move", "operator.layout.move")
    .at((ctx) => ({ path: "/operator/layout/move", headers: ctx.headers(), body: { plan: "mp_missing", items: [] } }))
    .status(400),
  http.protected
    .post("/operator/layout/upgrade/later", "operator.layout.later")
    .at((ctx) => ({ path: "/operator/layout/upgrade/later", headers: ctx.headers() }))
    .json(200, (body) => check(body === true, "the upgrade's confirmation waits for the next start")),
  http.protected
    .get("/operator/layout/move/{id}", "operator.layout.moveReport")
    .at((ctx) => ({ path: route("/operator/layout/move/{id}", { id: "mv_missing" }), headers: ctx.headers() }))
    .status(400),
  // Onboarding: finishing would set the working directory for every later scenario, so only its checks and a
  // refusal are exercised. Onboarding itself is tested in test/operator/onboarding.test.ts.
  http.protected.get("/operator/onboarding/status", "operator.onboarding.status").json(200, (body) => {
    object(body)
    check(typeof body.pending === "boolean", "onboarding should say whether it waits")
    check(typeof body.suggested === "string", "onboarding should suggest a working folder")
    array(body.agents)
  }),
  http.protected
    .post("/operator/onboarding/check", "operator.onboarding.check")
    .at((ctx) => ({
      path: "/operator/onboarding/check",
      headers: ctx.headers(),
      body: { workingDir: "relative/dir", project: "opencode" },
    }))
    .json(200, (body) => {
      object(body)
      array(body.problems)
      check(body.problems.length > 0, "a relative working folder should be refused")
    }),
  http.protected
    .post("/operator/onboarding/finish", "operator.onboarding.finish")
    .at((ctx) => ({
      path: "/operator/onboarding/finish",
      headers: ctx.headers(),
      body: { workingDir: "relative/dir", project: "opencode" },
    }))
    .status(400),
  http.protected.get("/operator/namespaces", "operator.namespace.list").json(200, (body) => {
    array(body)
    check(
      isRecord(body[0]) && isRecord(body[0].namespace) && body[0].namespace.id === "opencode",
      "OpenCode should be the first namespace",
    )
  }),
  // A namespace lives at <working directory>/<id>: with the exerciser's blank working directory, creating
  // one (and its folder's preview) is refused. Creating one is tested in test/operator/namespace-create.test.ts.
  http.protected
    .post("/operator/namespaces", "operator.namespace.create")
    .at((ctx) => ({
      path: "/operator/namespaces",
      headers: ctx.headers(),
      body: { name: "HttpApi team", purpose: "Test." },
    }))
    .status(400),
  http.protected
    .get("/operator/namespace-folder", "operator.namespace.folderPreview")
    .at((ctx) => ({ path: "/operator/namespace-folder?name=HttpApi%20team", headers: ctx.headers() }))
    .status(400),
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
      body: { purpose: "", defaultProject: "" },
    }))
    .json(
      200,
      (body) =>
        check(
          isRecord(body) && body.purpose === "" && body.defaultProject === undefined,
          "the purpose should be saved",
        ),
      "status",
    ),
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
  http.protected.get("/operator/project-settings", "operator.projectSettings.list").json(200, (body) => {
    array(body)
    // Each project has its short id (specs/docs/issues/002).
    for (const item of body as Array<{ id?: unknown }>)
      check(typeof item.id === "string", "a project should have its id")
  }),
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
  http.protected.get("/operator/capability", "operator.capability.list").json(200, (body) => {
    object(body)
    array(body.items)
    check(
      body.items.some(
        (item) => isRecord(item) && item.kind === "tool" && item.name === "read" && item.origin === "opencode",
      ),
      "OpenCode's read tool should be listed as OpenCode's",
    )
  }),
  http.protected
    .post("/operator/capability/override", "operator.capability.override")
    .at((ctx) => ({
      path: "/operator/capability/override",
      headers: ctx.headers(),
      body: { kind: "tool", name: "read" },
    }))
    .status(400),
  http.protected
    .post("/operator/capability/disable", "operator.capability.disable")
    .mutating()
    .at((ctx) => ({
      path: "/operator/capability/disable?confirmCopy=true",
      headers: ctx.headers(),
      body: { kind: "tool", name: "webfetch" },
    }))
    .json(200, (body) => check(isRecord(body) && body.state === "disabled", "webfetch should be turned off"), "status"),
  http.protected
    .post("/operator/capability/revert", "operator.capability.revert")
    .at((ctx) => ({
      path: "/operator/capability/revert",
      headers: ctx.headers(),
      body: { kind: "command", name: "missing" },
    }))
    .status(400),
  http.protected
    .post("/operator/capability/remove", "operator.capability.remove")
    .at((ctx) => ({
      path: "/operator/capability/remove",
      headers: ctx.headers(),
      body: { kind: "tool", name: "read" },
    }))
    .status(400),
  http.protected
    .post("/operator/capability/copy", "operator.capability.copy")
    .at((ctx) => ({
      path: "/operator/capability/copy",
      headers: ctx.headers(),
      body: { kind: "command", name: "missing", namespace: "opencode", to: "opencode" },
    }))
    .status(400),
  http.protected
    .get("/operator/capability/source", "operator.capability.source")
    .at((ctx) => ({
      path: "/operator/capability/source?kind=tool&name=read",
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .put("/operator/capability/source", "operator.capability.edit")
    .at((ctx) => ({
      path: "/operator/capability/source",
      headers: ctx.headers(),
      body: { kind: "tool", name: "read", text: "x" },
    }))
    .status(400),
  http.protected
    .post("/operator/capability/take-opencode", "operator.capability.takeOpenCode")
    .at((ctx) => ({
      path: "/operator/capability/take-opencode",
      headers: ctx.headers(),
      body: { kind: "command", name: "init" },
    }))
    .status(400),
  http.protected
    .post("/operator/capability/seed", "operator.capability.seed")
    .at((ctx) => ({
      path: "/operator/capability/seed",
      headers: ctx.headers(),
      body: { from: "opencode", to: "missing", items: [] },
    }))
    .status(400),
  http.protected
    .post("/operator/capability/create", "operator.capability.create")
    .at((ctx) => ({
      path: "/operator/capability/create",
      headers: ctx.headers(),
      body: { kind: "agent", name: "helper" },
    }))
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
    .get("/operator/project-records", "operator.projectRecord.list")
    .global()
    .json(200, (body) => {
      array(body)
    }),
  http.protected
    .put("/operator/project-records", "operator.projectRecord.update")
    .mutating()
    .at((ctx) => ({
      path: "/operator/project-records",
      headers: ctx.headers(),
      body: { key: ctx.directory ?? "/tmp/x", description: "Ship it", members: ["build"], manager: "build" },
    }))
    .json(200, (body) => {
      object(body)
      check(body.manager === "build", "the manager should be saved")
    }),
  http.protected
    .put("/operator/project-records", "operator.projectRecord.update.invalid")
    .at((ctx) => ({
      path: "/operator/project-records",
      headers: ctx.headers(),
      body: { key: ctx.directory ?? "/tmp/x", members: ["build"], manager: "plan" },
    }))
    .status(400),
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
  // A folder the console hasn't made a project (specs/docs/issues/002): its sessions can be archived.
  http.protected
    .post("/operator/project-settings/folder/archive", "operator.folderSessions.archive")
    .mutating()
    .at((ctx) => ({
      path: "/operator/project-settings/folder/archive",
      headers: ctx.headers(),
      body: { directory: ctx.directory ?? "/tmp/x" },
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.archived === "number", "the archived sessions should be counted")
    }),
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
  // Providers connected or disconnected (specs/docs/issues/001): the projects still waiting to reload.
  http.protected.get("/operator/model/providers-waiting", "operator.model.providersWaiting").json(200, array),
  // The Config page's reference (specs/docs/issues/003): every option of the config schema, each described.
  http.protected.get("/operator/config/reference", "operator.config.reference").json(200, (body) => {
    array(body)
    const paths = new Set((body as Array<{ path: string; description: string }>).map((item) => item.path))
    check(
      paths.has("provider.<id>.options") && paths.has("operatorRecordCalls"),
      "nested and fork keys should be listed",
    )
    check(
      (body as Array<{ description: string }>).every((item) => item.description.length > 0),
      "every option should have a description",
    )
  }),
  // A form's counters.
  http.protected
    .post("/operator/tokenizers/count", "operator.call.count")
    .at((ctx) => ({ path: "/operator/tokenizers/count", headers: ctx.headers(), body: { text: "one two three" } }))
    .json(200, (body) => {
      object(body)
      check(typeof body.tokens === "number" && body.tokens > 0, "the text should have tokens")
    }),
  // Helpers (agent_types_spec.md §4): every namespace lists the built-in ones, read-only.
  http.protected
    .get("/operator/helper", "operator.helper.list")
    .at((ctx) => ({ path: "/operator/helper?ns=opencode", headers: ctx.headers() }))
    .json(200, (body) => {
      array(body)
      check(
        (body as Array<{ name?: string; builtin?: boolean }>).some((item) => item.name === "title" && item.builtin),
        "the built-in title helper should be listed",
      )
    }),
  http.protected
    .post("/operator/helper/{ns}", "operator.helper.create")
    .at((ctx) => ({
      path: route("/operator/helper/{ns}", { ns: "opencode" }),
      headers: ctx.headers(),
      body: { name: "title", model: { source: "small" }, text: "x" },
    }))
    .status(400),
  http.protected
    .patch("/operator/helper/{ns}/{name}", "operator.helper.update")
    .at((ctx) => ({
      path: route("/operator/helper/{ns}/{name}", { ns: "opencode", name: "title" }),
      headers: ctx.headers(),
      body: { text: "x" },
    }))
    .status(400),
  http.protected
    .delete("/operator/helper/{ns}/{name}", "operator.helper.remove")
    .at((ctx) => ({
      path: route("/operator/helper/{ns}/{name}", { ns: "opencode", name: "title" }),
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .get("/operator/helper/{ns}/{name}/runs", "operator.helper.runs")
    .at((ctx) => ({
      path: route("/operator/helper/{ns}/{name}/runs", { ns: "opencode", name: "missing" }),
      headers: ctx.headers(),
    }))
    .json(200, array),
  // Triggers (agent_types_spec.md §4.9): a missing helper has none, and none to run now.
  http.protected
    .get("/operator/helper/{ns}/{name}/triggers", "operator.helper.triggers")
    .at((ctx) => ({
      path: route("/operator/helper/{ns}/{name}/triggers", { ns: "opencode", name: "missing" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => check(Array.isArray(body) && body.length === 0, "a missing helper has no triggers")),
  http.protected
    .post("/operator/helper/{ns}/{name}/triggers/{id}/run", "operator.helper.runTrigger")
    .at((ctx) => ({
      path: route("/operator/helper/{ns}/{name}/triggers/{id}/run", { ns: "opencode", name: "missing", id: "t1" }),
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected.get("/operator/helper-settings", "operator.helper.settings").json(200, (body) => {
    object(body)
    check(typeof body.runDays === "number", "runs are kept for some days")
    check(typeof body.triggersPaused === "boolean", "triggers are paused or not")
  }),
  http.protected
    .put("/operator/helper-settings", "operator.helper.saveSettings")
    .at((ctx) => ({ path: "/operator/helper-settings", headers: ctx.headers(), body: { runDays: 0 } }))
    .status(400),
  http.protected.get("/operator/notifications", "operator.notification.list").json(200, array),
  http.protected
    .delete("/operator/notifications/{id}", "operator.notification.dismiss")
    .at((ctx) => ({ path: route("/operator/notifications/{id}", { id: "missing" }), headers: ctx.headers() }))
    .json(200, (body) => check(body === false, "nothing to dismiss")),
  http.protected
    .get("/operator/telemetry/sessions", "operator.telemetry.sessions")
    .at((ctx) => ({ path: "/operator/telemetry/sessions?range=24h&roots=1&sort=cost:desc", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.rows)
      check(typeof body.total === "number", "a page counts the matching sessions")
    }),
  http.protected
    .get("/operator/telemetry/session/{id}", "operator.telemetry.session")
    .at((ctx) => ({ path: route("/operator/telemetry/session/{id}", { id: "ses_missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .get("/operator/telemetry/session/{id}/turn/{turnID}", "operator.telemetry.turn")
    .at((ctx) => ({
      path: route("/operator/telemetry/session/{id}/turn/{turnID}", { id: "ses_missing", turnID: "turn:msg_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .post("/operator/telemetry/session/{id}/keep", "operator.telemetry.keep")
    .at((ctx) => ({
      path: route("/operator/telemetry/session/{id}/keep", { id: "ses_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .delete("/operator/telemetry/session/{id}/keep", "operator.telemetry.unkeep")
    .at((ctx) => ({
      path: route("/operator/telemetry/session/{id}/keep", { id: "ses_missing" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => check(body === false, "nothing was kept")),
  http.protected
    .get("/operator/telemetry/span/{id}", "operator.telemetry.span")
    .at((ctx) => ({ path: route("/operator/telemetry/span/{id}", { id: "turn:missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .get("/operator/telemetry/events", "operator.telemetry.events")
    .at((ctx) => ({
      path: "/operator/telemetry/events?range=1h&kind=tool_call,model_call&status=error",
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.rows)
      check(typeof body.seq === "number", "a page has the seq for the live tail")
    }),
  http.protected
    .get("/operator/telemetry/logs", "operator.telemetry.logs")
    .at((ctx) => ({ path: "/operator/telemetry/logs?level=warn&after=0", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.rows)
    }),
  http.protected
    .get("/operator/telemetry/facets", "operator.telemetry.facets")
    .at((ctx) => ({ path: "/operator/telemetry/facets?scope=events&field=kind&range=7d", headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/operator/telemetry/metrics", "operator.telemetry.metrics")
    .at((ctx) => ({ path: "/operator/telemetry/metrics?metric=calls&groupBy=model&range=6h", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      array(body.series)
      check(body.step === 5 * 60_000, "a 6 h range steps by 5 minutes")
      check(body.source === "events", "inside the detailed window, from events")
    }),
  http.protected.get("/operator/telemetry/alert/rule", "operator.telemetry.alertRules").json(200, (body) => {
    array(body)
    check(
      body.some((item) => isRecord(item) && isRecord(item.rule) && item.rule.builtin === "rate_limited"),
      "the built-in rules are listed",
    )
  }),
  http.protected
    .post("/operator/telemetry/alert/rule", "operator.telemetry.alertRuleCreate")
    .at((ctx) => ({
      path: "/operator/telemetry/alert/rule",
      headers: ctx.headers(),
      body: {
        name: "Exerciser rule",
        metric: "denials",
        op: ">=",
        threshold: 3,
        window: "15",
        consecutive: 1,
        scope: {},
        severity: "warning",
        enabled: true,
      },
    }))
    .json(200, (body) => {
      object(body)
      check(isRecord(body.rule) && body.rule.name === "Exerciser rule", "the new rule")
    }),
  http.protected
    .put("/operator/telemetry/alert/rule/{id}", "operator.telemetry.alertRuleUpdate")
    .at((ctx) => ({
      path: route("/operator/telemetry/alert/rule/{id}", { id: "builtin-rate_limited" }),
      headers: ctx.headers(),
      body: {
        name: "Rate limited",
        metric: "rate_limits",
        op: ">=",
        threshold: 8,
        window: "15",
        consecutive: 1,
        scope: {},
        severity: "warning",
        enabled: true,
      },
    }))
    .json(200, (body) => check(isRecord(body) && isRecord(body.rule) && body.rule.threshold === 8, "saved")),
  http.protected
    .delete("/operator/telemetry/alert/rule/{id}", "operator.telemetry.alertRuleDelete")
    .at((ctx) => ({
      path: route("/operator/telemetry/alert/rule/{id}", { id: "builtin-rate_limited" }),
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/operator/telemetry/alert/rule/{id}/mute", "operator.telemetry.alertRuleMute")
    .at((ctx) => ({
      path: route("/operator/telemetry/alert/rule/{id}/mute", { id: "builtin-rate_limited" }),
      headers: ctx.headers(),
      body: { for: "1h" },
    }))
    .json(200, (body) => check(isRecord(body) && body.muted === true, "muted")),
  http.protected
    .post("/operator/telemetry/alert/rule/{id}/reset", "operator.telemetry.alertRuleReset")
    .at((ctx) => ({
      path: route("/operator/telemetry/alert/rule/{id}/reset", { id: "builtin-rate_limited" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => check(isRecord(body) && isRecord(body.rule) && body.rule.threshold === 5, "defaults back")),
  http.protected
    .get("/operator/telemetry/alert/event", "operator.telemetry.alertEvents")
    .at((ctx) => ({ path: "/operator/telemetry/alert/event?range=7d", headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .post("/operator/telemetry/alert/event/{id}/ack", "operator.telemetry.alertAck")
    .at((ctx) => ({
      path: route("/operator/telemetry/alert/event/{id}/ack", { id: "alert-missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected.get("/operator/telemetry/view", "operator.telemetry.views").json(200, (body) => {
    array(body)
    check(
      body.some((item) => isRecord(item) && item.builtin === "errors"),
      "the built-in views are listed",
    )
  }),
  http.protected
    .post("/operator/telemetry/view", "operator.telemetry.viewCreate")
    .at((ctx) => ({
      path: "/operator/telemetry/view",
      headers: ctx.headers(),
      body: { name: "Exerciser view", state: { tab: "events", params: { status: "error", range: "7d" } } },
    }))
    .json(200, (body) => {
      object(body)
      check(body.name === "Exerciser view", "the new view")
      check(isRecord(body.state) && isRecord(body.state.params) && !("range" in body.state.params), "no range kept")
    }),
  http.protected
    .put("/operator/telemetry/view/{id}", "operator.telemetry.viewUpdate")
    .at((ctx) => ({
      path: route("/operator/telemetry/view/{id}", { id: "builtin-errors" }),
      headers: ctx.headers(),
      body: { name: "Renamed" },
    }))
    .status(400),
  http.protected
    .delete("/operator/telemetry/view/{id}", "operator.telemetry.viewDelete")
    .at((ctx) => ({ path: route("/operator/telemetry/view/{id}", { id: "view-missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected.get("/operator/telemetry/settings", "operator.telemetry.settings").json(200, (body) => {
    object(body)
    check(typeof body.eventsDays === "number" && isRecord(body.limits), "settings with their limits")
  }),
  http.protected
    .put("/operator/telemetry/settings", "operator.telemetry.settingsUpdate")
    .at((ctx) => ({
      path: "/operator/telemetry/settings",
      headers: ctx.headers(),
      body: {
        enabled: true,
        eventsDays: 0,
        totalsDays: 400,
        logLevel: "warn",
        loops: { sameCallSameResult: 3, sameCall: 5, toolCalls: 50, modelCalls: 30 },
        dailyBudget: null,
        stuckMinutes: 10,
        queueMinutes: 10,
        recordCalls: true,
      },
    }))
    .status(400),
  http.protected
    .post("/operator/telemetry/clear", "operator.telemetry.clear")
    .json(200, (body) => check(isRecord(body) && typeof body.trash === "string", "the store went to Trash")),
  http.protected
    .get("/operator/telemetry/export/count", "operator.telemetry.exportCount")
    .at((ctx) => ({ path: "/operator/telemetry/export/count?tab=events&range=24h", headers: ctx.headers() }))
    .json(200, (body) => check(isRecord(body) && body.limit === 100_000, "the limit")),
  http.protected
    .get("/operator/telemetry/export", "operator.telemetry.export")
    .at((ctx) => ({
      path: "/operator/telemetry/export?tab=logs&format=csv&range=24h&tz=60",
      headers: ctx.headers(),
    }))
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.text.startsWith("time_ms,level,message"), "a CSV with its header")
        }),
      "status",
    ),
  http.protected.get("/operator/telemetry/backfill", "operator.telemetry.backfillStatus").json(200, (body) => {
    object(body)
    check(["idle", "running", "done", "failed"].includes(String(body.state)), "a known state")
  }),
  http.protected
    .post("/operator/telemetry/backfill", "operator.telemetry.backfill")
    .mutating()
    .json(200, (body) => {
      object(body)
      check(["running", "done"].includes(String(body.state)), "it runs, or has run")
    }),
  http.protected.get("/operator/telemetry/storage", "operator.telemetry.storage").json(200, (body) => {
    object(body)
    check(typeof body.bytes === "number" && typeof body.spans === "number", "the store's size and rows")
    check(body.eventsDays === 30, "the default retention")
    check(typeof body.logPath === "string" && body.logLevel === "warn", "the log it keeps lines from, and the level")
  }),
]
