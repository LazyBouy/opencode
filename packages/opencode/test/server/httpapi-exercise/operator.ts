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
  http.protected.get("/operator/config/schema", "operator.config.schema").json(200, (body) => {
    object(body)
    object(body.properties)
    object(body.properties.merge)
  }),
]
