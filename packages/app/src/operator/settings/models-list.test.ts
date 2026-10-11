import { describe, expect, test } from "bun:test"

// Settings → Models is the fork's tab (models.tsx), built from upstream's (components/settings-v2/models.tsx),
// which stays untouched. Its list must show the same models, in the same order and groups: these are the
// lines both share. When upstream changes one, this fails, and the fork's list is brought in step.

const read = (relative: string) => Bun.file(new URL(relative, import.meta.url)).text()
const squash = (text: string) => text.replace(/\s+/g, " ")

// Upstream's lines, and the fork's where it types them.
const SHARED: ReadonlyArray<[upstream: string, fork?: string]> = [
  ['filterKeys: ["provider.name", "name", "id"],'],
  [
    "sortBy: (a, b) => a.name.localeCompare(b.name),",
    "sortBy: (a: ModelItem, b: ModelItem) => a.name.localeCompare(b.name),",
  ],
  ["groupBy: (x) => x.provider.id,", "groupBy: (x: ModelItem) => x.provider.id,"],
  ["const aIndex = popularProviders.indexOf(a.category)"],
  ["const bIndex = popularProviders.indexOf(b.category)"],
  ["if (aPopular && !bPopular) return -1"],
  ["if (!aPopular && bPopular) return 1"],
  ["if (aPopular && bPopular) return aIndex - bIndex"],
  ["const aName = a.items[0].provider.name"],
  ["return aName.localeCompare(bName)"],
  ['Persist.serverGlobal(serverSdk().scope, "settings-v2.models.providers")'],
  ["checked={models.visible(key)}"],
  ["models.setVisibility(key, checked)"],
  ["const expanded = () => searching() || !store.collapsed[group.category]"],
]

describe("Settings → Models", () => {
  test("the fork's list is upstream's: same filter, order, groups and visibility", async () => {
    const upstream = squash(await read("../../components/settings-v2/models.tsx"))
    const fork = squash(await read("./models.tsx"))
    for (const [line, typed] of SHARED) {
      expect(upstream).toContain(squash(line))
      expect(fork).toContain(squash(typed ?? line))
    }
  })
})
