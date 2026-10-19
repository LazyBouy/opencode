export * as OperatorTelemetryAlerting from "./alerting"

import os from "os"
import { Context, Effect, Layer, Schedule, Schema, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { OperatorProfileStore } from "../profile-store"
import { OperatorTelemetryAlertRules as Rules } from "./alert-rules"
import { OperatorTelemetryAlerts as A } from "./alerts"
import { OperatorTelemetryNames } from "./names"
import { OperatorTelemetryQuery } from "./query"
import { OperatorTelemetryStore } from "./store"
import { OperatorTelemetry } from "./telemetry"

// Alerts (observability_spec.md §14): evaluates every rule every 60 s from spans and samples, keeps each rule's state,
// and records one alert event per firing period (rule, start, end, the value when it fired, the worst value, the
// threshold, the scope and where View events goes). Each event is also a span of kind `alert`, so an incident's
// timeline in Events shows it. Acknowledging records who and when. A rule that can't be evaluated says so and never
// fires because of it; nothing is sent outside the app.

const SERVICE = "operator-telemetry"
const HOUR = 60 * 60 * 1000

export class AlertError extends Schema.TaggedErrorClass<AlertError>()("OperatorTelemetryAlertError", {
  message: Schema.String,
  missing: Schema.optional(Schema.Boolean),
}) {}

export type RuleView = { rule: A.Rule; state: A.State; muted: boolean }
export type Event = {
  id: string
  rule_id: string
  name: string
  severity: string
  metric: string
  op: string
  threshold: number
  win: string
  start_ms: number
  end_ms: number | null
  value: number | null
  worst: number | null
  scope: Record<string, string>
  link: Record<string, string>
  ack_by: string | null
  ack_ms: number | null
  /** Its rule is muted now. */
  muted: boolean
}
export const MUTES = ["1h", "4h", "24h", "always", "off"] as const
export type Mute = (typeof MUTES)[number]

export interface Interface {
  readonly rules: () => Effect.Effect<RuleView[]>
  readonly create: (input: A.RuleInput) => Effect.Effect<RuleView, AlertError>
  readonly update: (id: string, input: A.RuleInput) => Effect.Effect<RuleView, AlertError>
  /** Moves a user rule to Trash; built-in rules can't be deleted. */
  readonly remove: (id: string) => Effect.Effect<void, AlertError>
  readonly mute: (id: string, value: Mute) => Effect.Effect<RuleView, AlertError>
  /** A built-in rule back to its defaults. */
  readonly reset: (id: string) => Effect.Effect<RuleView, AlertError>
  readonly events: (input: { from?: number; to?: number; firing?: boolean; limit?: number }) => Effect.Effect<Event[]>
  readonly acknowledge: (id: string) => Effect.Effect<Event, AlertError>
  /** One round of evaluation (every 60 s; tests call it). */
  readonly evaluate: (now?: number) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OperatorTelemetryAlerting") {}

type EventRow = Omit<Event, "scope" | "link" | "muted"> & { scope: string | null; link: string | null }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const telemetry = yield* OperatorTelemetry.Service
    const profiles = yield* OperatorProfileStore.Service
    const config = yield* Config.Service
    const scope = yield* Scope.Scope
    const store = () => OperatorTelemetryStore.store()
    const budget = () => telemetry.settings().dailyBudget
    const fail = (message: string, missing?: boolean) => new AlertError({ message, ...(missing ? { missing } : {}) })
    const list = () => Effect.promise(() => Rules.list(budget()))

    // ---- state and events ----

    const stateOf = (id: string): A.State =>
      (store().db.query("SELECT * FROM alert_state WHERE rule_id = ?").get(id) as A.State | null) ?? A.INITIAL
    const saveState = (id: string, state: A.State) =>
      store()
        .db.query(
          `INSERT OR REPLACE INTO alert_state (rule_id, state, streak, clear, value, count, evaluated_ms, error, event_id, last_fired_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          state.state,
          state.streak,
          state.clear,
          state.value,
          state.count,
          state.evaluated_ms,
          state.error,
          state.event_id,
          state.last_fired_ms,
        )
    const eventRow = (id: string) =>
      store().db.query("SELECT * FROM alert_event WHERE id = ?").get(id) as EventRow | null
    const parse = (value: string | null) => {
      try {
        return value ? (JSON.parse(value) as Record<string, string>) : {}
      } catch {
        return {}
      }
    }
    const eventOf = (row: EventRow, muted: boolean): Event => ({
      ...row,
      scope: parse(row.scope),
      link: parse(row.link),
      muted,
    })
    // The event as a span, for Events (§14.5).
    const mirror = (row: EventRow) => {
      const scoped = parse(row.scope)
      telemetry.record({
        id: `alert:${row.id}`,
        kind: "alert",
        name: OperatorTelemetryNames.name("alert", row.name),
        status: row.end_ms === null ? "running" : "ok",
        start_ms: row.start_ms,
        end_ms: row.end_ms,
        duration_ms: row.end_ms === null ? null : row.end_ms - row.start_ms,
        project_key: scoped.dir ?? null,
        agent: scoped.agent ?? null,
        model: scoped.model ?? null,
        provider: scoped.provider ?? null,
        tool: scoped.tool ?? null,
        error_type: row.severity,
        source: "alert",
        attrs: JSON.stringify({
          rule: row.rule_id,
          severity: row.severity,
          metric: row.metric,
          op: row.op,
          threshold: row.threshold,
          window: row.win,
          value: row.value,
          worst: row.worst,
        }),
      })
    }
    const open = (rule: A.Rule, value: number, now: number) => {
      const id = `alert-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`
      store()
        .db.query(
          `INSERT INTO alert_event (id, rule_id, name, severity, metric, op, threshold, win, start_ms, end_ms, value, worst, scope, link)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          id,
          rule.id,
          rule.name,
          rule.severity,
          rule.metric,
          rule.op,
          rule.threshold,
          rule.window,
          now,
          value,
          value,
          JSON.stringify(rule.scope),
          JSON.stringify(A.linkOf(rule)),
        )
      return id
    }
    const close = (id: string, now: number) =>
      store().db.query("UPDATE alert_event SET end_ms = ? WHERE id = ? AND end_ms IS NULL").run(now, id)

    // Ends a rule's open event at once (the rule was disabled or deleted).
    const settle = (id: string, now: number, state?: A.StateName) => {
      const previous = stateOf(id)
      if (previous.event_id) {
        close(previous.event_id, now)
        const row = eventRow(previous.event_id)
        if (row) mirror(row)
      }
      if (state) saveState(id, { ...previous, state, streak: 0, clear: 0, event_id: null })
      else store().db.query("DELETE FROM alert_state WHERE rule_id = ?").run(id)
    }

    // ---- evaluation (§14.4) ----

    const evaluate = (at?: number) =>
      Effect.gen(function* () {
        if (!telemetry.settings().enabled) return
        const now = at ?? Date.now()
        const rules = yield* list()
        const context: A.Context = {
          ...OperatorTelemetryQuery.contextOf(yield* profiles.projects(), {
            now,
            stuckMinutes: telemetry.settings().stuckMinutes,
          }),
          activeFolders: telemetry.activeFolders(),
        }
        const changed: string[] = []
        const warnings: Array<{ rule: string; error: string }> = []
        store().transaction(() => {
          for (const rule of rules) {
            const previous = stateOf(rule.id)
            let measured: A.Measured | { error: string } = { value: null, count: null }
            if (rule.enabled)
              try {
                measured = A.measure(store(), rule, context)
              } catch (error) {
                measured = { error: error instanceof Error ? error.message : String(error) }
                warnings.push({ rule: rule.id, error: measured.error })
              }
            const step = A.advance(previous, rule, measured, now)
            const next = { ...step.next }
            if (step.open !== undefined) {
              next.event_id = open(rule, step.open, now)
              changed.push(next.event_id)
            }
            if (step.close && previous.event_id) {
              close(previous.event_id, now)
              changed.push(previous.event_id)
              next.event_id = null
            }
            if (step.worst !== undefined && previous.event_id) {
              const row = eventRow(previous.event_id)
              const worst = A.worse(rule.op, row?.worst ?? null, step.worst)
              if (row && worst !== row.worst) {
                store().db.query("UPDATE alert_event SET worst = ? WHERE id = ?").run(worst, row.id)
                changed.push(row.id)
              }
            }
            saveState(rule.id, next)
          }
          // Rules that are gone (deleted, or their file removed): their open events end.
          const ids = new Set(rules.map((rule) => rule.id))
          for (const row of store().db.query("SELECT rule_id FROM alert_state").all() as Array<{ rule_id: string }>)
            if (!ids.has(row.rule_id)) {
              const previous = stateOf(row.rule_id)
              if (previous.event_id) {
                close(previous.event_id, now)
                changed.push(previous.event_id)
              }
              store().db.query("DELETE FROM alert_state WHERE rule_id = ?").run(row.rule_id)
            }
        })
        for (const id of changed) {
          const row = eventRow(id)
          if (row) mirror(row)
        }
        for (const warning of warnings)
          yield* Effect.logWarning("alert rule couldn't be evaluated", { service: SERVICE, ...warning })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("alert evaluation failed", { service: SERVICE, error: String(cause) }),
        ),
      )

    // ---- rules ----

    const viewOf = (rule: A.Rule, now = Date.now()): RuleView => {
      const state = stateOf(rule.id)
      return {
        rule,
        state: state.evaluated_ms === null && !rule.enabled ? { ...state, state: "disabled" } : state,
        muted: A.mutedAt(rule, now),
      }
    }
    const find = (id: string) =>
      Effect.gen(function* () {
        const rule = (yield* list()).find((item) => item.id === id)
        if (!rule) return yield* fail(`No alert rule ${id}`, true)
        return rule
      })
    const check = (input: A.RuleInput) =>
      Effect.gen(function* () {
        const name = input.name.trim()
        if (!name) return yield* fail("A rule needs a name")
        if (!Number.isFinite(input.threshold)) return yield* fail("The threshold must be a number")
        if (!Number.isInteger(input.consecutive) || input.consecutive < 1 || input.consecutive > 10)
          return yield* fail("'For' is 1 to 10 evaluations in a row")
        if (input.minCount !== undefined && (!Number.isInteger(input.minCount) || input.minCount < 0))
          return yield* fail("The minimum count is a whole number, 0 or more")
        const scope = Object.fromEntries(
          A.SCOPE_FIELDS.flatMap((field) => (input.scope[field]?.trim() ? [[field, input.scope[field]!.trim()]] : [])),
        ) as A.Scope
        return {
          name,
          metric: input.metric,
          op: input.op,
          threshold: input.threshold,
          window: input.window,
          ...(input.minCount !== undefined && A.METRIC_INFO[input.metric].minimum ? { minCount: input.minCount } : {}),
          consecutive: input.consecutive,
          scope,
          severity: input.severity,
          enabled: input.enabled,
        } satisfies A.RuleInput
      })
    const save = (rule: A.Rule) => Effect.promise(() => Rules.write(rule)).pipe(Effect.map((saved) => viewOf(saved)))

    const create = (input: A.RuleInput) =>
      Effect.gen(function* () {
        const clean = yield* check(input)
        const now = Date.now()
        return yield* save({ ...clean, id: Rules.newId(), createdAt: now, updatedAt: now })
      })
    const update = (id: string, input: A.RuleInput) =>
      Effect.gen(function* () {
        const rule = yield* find(id)
        const clean = yield* check(input)
        const now = Date.now()
        const next: A.Rule = {
          ...clean,
          id,
          ...(rule.builtin ? { builtin: rule.builtin } : {}),
          ...(rule.mute ? { mute: rule.mute } : {}),
          createdAt: rule.createdAt || now,
          updatedAt: now,
        }
        if (!next.enabled && rule.enabled) settle(id, now, "disabled")
        return yield* save(next)
      })
    const remove = (id: string) =>
      Effect.gen(function* () {
        const rule = yield* find(id)
        if (rule.builtin) return yield* fail("Built-in rules can't be deleted; turn the rule off instead")
        yield* Effect.tryPromise({
          try: () => Rules.trash(rule),
          catch: (error) => fail(error instanceof Error ? error.message : String(error)),
        })
        settle(id, Date.now())
      })
    const mute = (id: string, value: Mute) =>
      Effect.gen(function* () {
        const rule = yield* find(id)
        const now = Date.now()
        const until = { "1h": now + HOUR, "4h": now + 4 * HOUR, "24h": now + 24 * HOUR } as Record<string, number>
        const { mute: _mute, ...rest } = rule
        const next: A.Rule = {
          ...rest,
          ...(value === "off" ? {} : { mute: value === "always" ? {} : { until: until[value]! } }),
          createdAt: rule.createdAt || now,
          updatedAt: now,
        }
        return yield* save(next)
      })
    const reset = (id: string) =>
      Effect.gen(function* () {
        const rule = yield* find(id)
        if (!rule.builtin) return yield* fail("Only built-in rules have defaults to reset to")
        yield* Effect.promise(() => Rules.reset(id))
        const fresh = yield* find(id)
        if (!fresh.enabled) settle(id, Date.now(), "disabled")
        return viewOf(fresh)
      })

    // ---- events ----

    const events = (input: { from?: number; to?: number; firing?: boolean; limit?: number }) =>
      Effect.gen(function* () {
        const rules = yield* list()
        const now = Date.now()
        const muted = new Set(rules.filter((rule) => A.mutedAt(rule, now)).map((rule) => rule.id))
        const limit = Math.min(Math.max(1, input.limit ?? 200), 1000)
        const rows = (
          input.firing
            ? store()
                .db.query("SELECT * FROM alert_event WHERE end_ms IS NULL ORDER BY start_ms DESC LIMIT ?")
                .all(limit)
            : store()
                .db.query(
                  `SELECT * FROM alert_event WHERE start_ms < ? AND (end_ms IS NULL OR end_ms >= ?)
                   ORDER BY start_ms DESC LIMIT ?`,
                )
                .all(input.to ?? now + 1, input.from ?? 0, limit)
        ) as EventRow[]
        return rows.map((row) => eventOf(row, muted.has(row.rule_id)))
      })
    const acknowledge = (id: string) =>
      Effect.gen(function* () {
        const row = eventRow(id)
        if (!row) return yield* fail(`No alert ${id}`, true)
        if (row.ack_ms === null) {
          const global = yield* config.getGlobal().pipe(Effect.orElseSucceed(() => undefined))
          const who = global?.username || os.userInfo().username || "user"
          store().db.query("UPDATE alert_event SET ack_by = ?, ack_ms = ? WHERE id = ?").run(who, Date.now(), id)
        }
        const rule = (yield* list()).find((item) => item.id === row.rule_id)
        return eventOf(eventRow(id)!, rule ? A.mutedAt(rule, Date.now()) : false)
      })

    if (OperatorTelemetry.loopOn())
      yield* evaluate().pipe(
        Effect.repeat(Schedule.spaced("60 seconds")),
        Effect.delay("20 seconds"),
        Effect.forkIn(scope),
      )

    return Service.of({
      rules: () => list().pipe(Effect.map((rules) => rules.map((rule) => viewOf(rule)))),
      create,
      update,
      remove,
      mute,
      reset,
      events,
      acknowledge,
      evaluate,
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [OperatorTelemetry.node, OperatorProfileStore.node, Config.node],
})
