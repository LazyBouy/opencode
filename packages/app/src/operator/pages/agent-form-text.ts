import type {
  OperatorPromptAssembledSection,
  OperatorPromptLocalLayer,
  OperatorPromptOverride,
} from "@opencode-ai/sdk/v2/client"
import { DYNAMIC, HELPER, type Profile } from "./profile-model"

// The agent form's text edits in "System Prompt as sent" (agent_form_spec.md §6.3–§6.4), as changes to the agent's
// override, never to the namespace: an edited block becomes a text of the agent's own in its place (a copy, `basedOn`
// the layer it was made from), and text added between blocks a new one, of the type of the group it is added to. A
// slot names such a text as "agent:<localId>". Mirrors the server's rules (operator/profile.ts checkSlots).

export type Override = OperatorPromptOverride
export type LocalLayer = OperatorPromptLocalLayer
// A block of "System Prompt as sent".
export type Block = OperatorPromptAssembledSection

export const AGENT_LOCAL = "agent:"
// Purpose is automatic, Dynamic texts are filled in per request, output notices are OpenCode's; a helper has no
// override. Their blocks are locked.
export const LOCKED_TYPES = ["purpose", DYNAMIC, "output", HELPER]

export const isLocal = (entry: string) => entry.startsWith(AGENT_LOCAL)
export const localId = (entry: string) => entry.slice(AGENT_LOCAL.length)

// Whether the form can write a block: the agent's own prompt always (it is the agent's `prompt`), any other block
// of a type that isn't locked, with Override on.
export function editable(section: Pick<Block, "type" | "agentPrompt">, override: boolean) {
  if (section.agentPrompt) return true
  return override && !LOCKED_TYPES.includes(section.type)
}

// An override as the server keeps it: group, slots, then the agent's texts its slots name; empty parts left out.
export function tidy(override: Override): Override {
  const slots = override.slots ?? {}
  const named = new Set(Object.values(slots).flat().filter(isLocal).map(localId))
  const layers = Object.fromEntries(Object.entries(override.layers ?? {}).filter(([id]) => named.has(id)))
  return {
    ...(override.group ? { group: override.group } : {}),
    ...(Object.keys(slots).length ? { slots } : {}),
    ...(Object.keys(layers).length ? { layers } : {}),
  }
}

// What a save sends: a text emptied while editing is the block removed.
export function forSave(override: Override): Override {
  const blank = new Set(
    Object.entries(override.layers ?? {})
      .filter(([, item]) => !item.text.trim())
      .map(([id]) => `${AGENT_LOCAL}${id}`),
  )
  if (!blank.size) return tidy(override)
  const slots = Object.fromEntries(
    Object.entries(override.slots ?? {}).map(([type, ids]) => [type, ids.filter((id) => !blank.has(id))]),
  )
  return tidy({ ...override, slots })
}

// A type's slot as the agent has it: the override's, else the profile's.
export function slotOf(profile: Profile | undefined, override: Override, type: string): string[] {
  return [...(override.slots?.[type] ?? profile?.slots[type] ?? [])]
}

// The override with a type's slot set; a slot back to the profile's own is no longer changed.
export function withSlot(profile: Profile | undefined, override: Override, type: string, ids: string[]): Override {
  const slots = { ...(override.slots ?? {}) }
  if (JSON.stringify(ids) === JSON.stringify(profile?.slots[type] ?? [])) delete slots[type]
  else slots[type] = ids
  return tidy({ ...override, slots })
}

// The first free local id: "1", "2", ...
export function nextId(override: Override) {
  const taken = new Set(Object.keys(override.layers ?? {}))
  const free = (n: number): string => (taken.has(String(n)) ? free(n + 1) : String(n))
  return free(1)
}

// A block's new text. A text of the agent's own changes; any other block becomes one, a copy of its layer, in its
// place. Returns the entry the block has now.
export function editBlock(
  profile: Profile | undefined,
  override: Override,
  block: { type: string; entry: string },
  text: string,
): { override: Override; entry: string } {
  if (isLocal(block.entry)) {
    const id = localId(block.entry)
    const found = override.layers?.[id]
    const layers = { ...(override.layers ?? {}), [id]: { ...(found ?? { type: block.type }), text } }
    return { override: tidy({ ...override, layers }), entry: block.entry }
  }
  const ids = slotOf(profile, override, block.type)
  const at = ids.indexOf(block.entry)
  if (at < 0) return { override, entry: block.entry }
  const id = nextId(override)
  const entry = `${AGENT_LOCAL}${id}`
  const layers = { ...(override.layers ?? {}), [id]: { type: block.type, text, basedOn: block.entry } }
  return { override: withSlot(profile, { ...override, layers }, block.type, ids.toSpliced(at, 1, entry)), entry }
}

// New text of the agent's own, at `index` in a type's slot.
export function insertText(
  profile: Profile | undefined,
  override: Override,
  at: { type: string; index: number },
  text: string,
): Override {
  const id = nextId(override)
  const layers = { ...(override.layers ?? {}), [id]: { type: at.type, text } }
  const ids = slotOf(profile, override, at.type).toSpliced(at.index, 0, `${AGENT_LOCAL}${id}`)
  return withSlot(profile, { ...override, layers }, at.type, ids)
}

// A block taken out of the agent's slot (a text of its own goes with it).
export function removeBlock(profile: Profile | undefined, override: Override, block: { type: string; entry: string }) {
  const ids = slotOf(profile, override, block.type).filter((id) => id !== block.entry)
  return withSlot(profile, override, block.type, ids)
}

// A text of the agent's own put back to the layer it copies, when that layer is still there; new text is removed.
export function resetBlock(
  profile: Profile | undefined,
  override: Override,
  block: { type: string; entry: string },
  exists: (layer: string) => boolean,
) {
  const basedOn = override.layers?.[localId(block.entry)]?.basedOn
  const ids = slotOf(profile, override, block.type)
  const at = ids.indexOf(block.entry)
  if (at < 0) return override
  const back = basedOn && exists(basedOn) && !ids.includes(basedOn)
  return withSlot(profile, override, block.type, back ? ids.toSpliced(at, 1, basedOn) : ids.toSpliced(at, 1))
}

// Where text added between two blocks can go: the group types from the block above's to the block below's, in the
// group's order, that aren't locked (the one above first, the default). Each with the index in its slot: after the
// block above, before the block below, else at the end of a type with no blocks shown.
export function gapPlaces(
  profile: Profile | undefined,
  override: Override,
  types: ReadonlyArray<string>,
  above: { type: string; entry: string } | undefined,
  below: { type: string; entry: string } | undefined,
) {
  const from = above ? types.indexOf(above.type) : 0
  const to = below ? types.indexOf(below.type) : types.length - 1
  if (from < 0 || to < 0) return []
  return types
    .slice(from, to + 1)
    .filter((type) => !LOCKED_TYPES.includes(type))
    .map((type) => {
      const ids = slotOf(profile, override, type)
      if (above && type === above.type && ids.includes(above.entry))
        return { type, index: ids.indexOf(above.entry) + 1 }
      if (below && type === below.type && ids.includes(below.entry)) return { type, index: ids.indexOf(below.entry) }
      return { type, index: ids.length }
    })
}
