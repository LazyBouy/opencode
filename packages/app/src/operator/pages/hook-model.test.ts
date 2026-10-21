import { describe, expect, test } from "bun:test"
import { actionsOf, linesOf, namesOf, shownState, wouldDo } from "./hook-model"

const hook = (extra: Partial<Parameters<typeof shownState>[0]> = {}) => ({
  name: "guard",
  event: "tool.before",
  level: "namespace" as const,
  locked: false,
  state: "on" as const,
  problems: [],
  ...extra,
})

describe("a hook at the page's scope", () => {
  test("its state: on, off here or above, locked, disabled, invalid", () => {
    expect(shownState(hook(), "project")).toBe("on")
    expect(shownState(hook({ locked: true }), "project")).toBe("locked")
    expect(shownState(hook({ locked: true }), "namespace")).toBe("on")
    expect(shownState(hook({ state: "off", offAt: "project" }), "project")).toBe("offHere")
    expect(shownState(hook({ state: "off", offAt: "namespace" }), "project")).toBe("off")
    expect(shownState(hook({ state: "disabled" }), "project")).toBe("disabled")
    expect(shownState(hook({ state: "invalid" }), "project")).toBe("invalid")
  })

  test("what the scope may do: its own edited and deleted; inherited turned off, on or overridden unless locked", () => {
    expect(actionsOf(hook(), "namespace")).toEqual({
      edit: true,
      remove: true,
      turnOff: false,
      turnOn: false,
      override: false,
    })
    expect(actionsOf(hook(), "project")).toMatchObject({ turnOff: true, turnOn: false, override: true, edit: false })
    expect(actionsOf(hook({ state: "off", offAt: "project" }), "project")).toMatchObject({
      turnOff: false,
      turnOn: true,
    })
    expect(actionsOf(hook({ locked: true }), "project")).toMatchObject({
      turnOff: false,
      turnOn: false,
      override: false,
    })
  })
})

describe("what a Test run would do", () => {
  test("a deny, by event; an allow once; a failure, open or closed", () => {
    expect(wouldDo({ event: "tool.before", outcome: "denied", answer: { allow: false, reason: "no" } })).toEqual([
      { key: "operator.hooks.would.deny.tool", values: { reason: "no" } },
    ])
    expect(wouldDo({ event: "prompt.submitted", outcome: "denied", answer: { allow: false } })[0]?.key).toBe(
      "operator.hooks.would.deny.message",
    )
    expect(wouldDo({ event: "permission.asked", outcome: "allowed", answer: { allow: true } })).toEqual([
      { key: "operator.hooks.would.allowOnce" },
    ])
    expect(wouldDo({ event: "tool.before", outcome: "failed", answer: {}, cause: "it exited with 1" })).toEqual([
      { key: "operator.hooks.would.failed", values: { cause: "it exited with 1" } },
      { key: "operator.hooks.would.failClosed" },
    ])
    expect(
      wouldDo({
        event: "tool.before",
        outcome: "timed out",
        answer: {},
        cause: "timed out after 5 s",
        onFailure: "allow",
      })[1],
    ).toEqual({ key: "operator.hooks.would.failOpen" })
    // A failed permission.asked run asks the user; a watch event's failure is only recorded.
    expect(wouldDo({ event: "permission.asked", outcome: "failed", answer: {}, cause: "x" })[1]?.key).toBe(
      "operator.hooks.would.ask",
    )
    expect(wouldDo({ event: "turn.after", outcome: "failed", answer: {}, cause: "x" })).toHaveLength(1)
  })

  test("changes and context, where they'd go; nothing at all", () => {
    expect(
      wouldDo({ event: "tool.after", outcome: "changed", answer: { output: "short", context: "lint ok" } }),
    ).toEqual([
      { key: "operator.hooks.would.output", values: { value: "short" } },
      { key: "operator.hooks.would.context.result", values: { value: "lint ok" } },
    ])
    expect(wouldDo({ event: "tool.before", outcome: "changed", answer: { input: { command: "ls" } } })[0]).toEqual({
      key: "operator.hooks.would.input",
      values: { value: '{\n  "command": "ls"\n}' },
    })
    expect(wouldDo({ event: "step.before", outcome: "context", answer: { context: "x" } })[0]?.key).toBe(
      "operator.hooks.would.context.request",
    )
    expect(wouldDo({ event: "compaction.after", outcome: "denied", answer: { continue: false } })).toEqual([
      { key: "operator.hooks.would.noContinue" },
    ])
    expect(wouldDo({ event: "turn.after", outcome: "ok", answer: {} })).toEqual([
      { key: "operator.hooks.would.nothing" },
    ])
    expect(wouldDo({ event: "permission.asked", outcome: "ok", answer: {} })).toEqual([
      { key: "operator.hooks.would.ask" },
    ])
  })

  test("the form's lists", () => {
    expect(linesOf(" --strict \n\n--fast")).toEqual(["--strict", "--fast"])
    expect(namesOf("bash, edit  write")).toEqual(["bash", "edit", "write"])
  })
})
