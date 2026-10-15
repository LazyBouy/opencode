import { describe, expect, test } from "bun:test"
import {
  editBlock,
  editable,
  forSave,
  gapPlaces,
  insertText,
  nextId,
  removeBlock,
  resetBlock,
  tidy,
} from "./agent-form-text"
import type { Profile } from "./profile-model"

const profile: Profile = {
  id: "reviewing",
  name: "Reviewing",
  group: "g",
  slots: { role: ["reviewer", "kind"], identity: ["intro"], dynamic: ["opencode:slot.agent"] },
  builtin: false,
}
const types = ["purpose", "role", "identity", "dynamic", "additional", "output"]

describe("agent form text edits", () => {
  test("an edited layer becomes a copy of the agent's own in its place; editing it again changes the copy", () => {
    const first = editBlock(profile, {}, { type: "role", entry: "reviewer" }, "You review, briefly.")
    expect(first).toEqual({
      entry: "agent:1",
      override: {
        slots: { role: ["agent:1", "kind"] },
        layers: { "1": { type: "role", text: "You review, briefly.", basedOn: "reviewer" } },
      },
    })
    const again = editBlock(profile, first.override, { type: "role", entry: "agent:1" }, "You review.")
    expect(again.override.layers).toEqual({ "1": { type: "role", text: "You review.", basedOn: "reviewer" } })
    // Another block gets the next id.
    expect(editBlock(profile, again.override, { type: "identity", entry: "intro" }, "Hi.").entry).toBe("agent:2")
    expect(nextId({ layers: { "1": { type: "role", text: "a" }, "3": { type: "role", text: "b" } } })).toBe("2")
  })

  test("added text is new text of the group's type at its place; Reset puts a copy's layer back and removes new text", () => {
    const added = insertText(profile, {}, { type: "role", index: 1 }, "Cite the PR.")
    expect(added).toEqual({
      slots: { role: ["reviewer", "agent:1", "kind"] },
      layers: { "1": { type: "role", text: "Cite the PR." } },
    })
    // Removed: the slot is the profile's again, so the override is empty.
    expect(resetBlock(profile, added, { type: "role", entry: "agent:1" }, () => true)).toEqual({})
    const copy = editBlock(profile, {}, { type: "role", entry: "kind" }, "Be kinder.").override
    expect(resetBlock(profile, copy, { type: "role", entry: "agent:1" }, () => true)).toEqual({})
    // The layer it copies is gone: Reset removes the copy.
    expect(resetBlock(profile, copy, { type: "role", entry: "agent:1" }, () => false)).toEqual({
      slots: { role: ["reviewer"] },
    })
  })

  test("a removed block leaves the slot; a text emptied while editing is removed on save; texts no slot names go", () => {
    expect(removeBlock(profile, {}, { type: "role", entry: "kind" })).toEqual({ slots: { role: ["reviewer"] } })
    const emptied = editBlock(profile, {}, { type: "role", entry: "kind" }, " ").override
    expect(forSave(emptied)).toEqual({ slots: { role: ["reviewer"] } })
    expect(tidy({ slots: { role: [] }, layers: { "1": { type: "role", text: "a" } } })).toEqual({
      slots: { role: [] },
    })
    // Group, slots and texts in the server's order.
    expect(
      Object.keys(tidy({ layers: { "1": { type: "role", text: "a" } }, slots: { role: ["agent:1"] }, group: "x" })),
    ).toEqual(["group", "slots", "layers"])
  })

  test("text added between blocks goes into an open group from the one above to the one below", () => {
    const role = { type: "role", entry: "kind" }
    const dynamic = { type: "dynamic", entry: "opencode:slot.agent" }
    // Between Agent role and Dynamic: after the role block, or at the end of Agent identity (Dynamic is locked).
    expect(gapPlaces(profile, {}, types, role, dynamic)).toEqual([
      { type: "role", index: 2 },
      { type: "identity", index: 1 },
    ])
    // Inside one group: after the block above.
    expect(gapPlaces(profile, {}, types, { type: "role", entry: "reviewer" }, role)).toEqual([
      { type: "role", index: 1 },
    ])
    // After the last block: the open groups below it.
    expect(gapPlaces(profile, {}, types, dynamic, undefined)).toEqual([{ type: "additional", index: 0 }])
    // Before the first: from the top, before the block below.
    expect(gapPlaces(profile, {}, types, undefined, { type: "identity", entry: "intro" })).toEqual([
      { type: "role", index: 2 },
      { type: "identity", index: 0 },
    ])
  })

  test("the agent's own prompt is always written; other blocks with Override on, never locked types", () => {
    expect(editable({ type: "dynamic", agentPrompt: true }, false)).toBe(true)
    expect(editable({ type: "role" }, false)).toBe(false)
    expect(editable({ type: "role" }, true)).toBe(true)
    for (const type of ["purpose", "dynamic", "output", "helper"]) expect(editable({ type }, true)).toBe(false)
  })
})
