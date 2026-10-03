// Route scenarios for this fork's endpoints (merge, operator console). Kept out of index.ts so
// upstream changes to the shared scenario list merge without conflicts.
import { Effect } from "effect"
import { array, boolean, check, isRecord, object } from "./assertions"
import { http, route } from "./dsl"
import { type Scenario } from "./types"

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
    .at((ctx) => ({ path: `/operator/session?directory=${encodeURIComponent(ctx.directory ?? "")}`, headers: ctx.headers() }))
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
    .get("/operator/permission", "operator.permission.pending")
    .global()
    .json(200, array),
  http.protected.get("/operator/agent", "operator.agent.list").json(200, (body) => {
    array(body)
    const build = body.find((agent) => isRecord(agent) && agent.name === "build")
    object(build)
    object(build.source)
    check(build.source.kind === "builtin", "build should be a built-in agent")
  }),
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
]
