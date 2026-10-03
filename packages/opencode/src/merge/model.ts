import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "@/provider/provider"

const modalities = { text: true, audio: false, image: false, video: false, pdf: false }

// A merged turn is produced by the child harness, not by an OpenCode provider. This zero-cost,
// zero-context model lets the session processor record that turn without pricing it or
// triggering overflow compaction, and without requiring any configured OpenCode provider.
export function stub(adapter: string, name?: string): Provider.Model {
  return {
    id: ModelV2.ID.make(name ?? adapter),
    providerID: ProviderV2.ID.make(`${adapter}-code`),
    api: { id: name ?? adapter, url: "", npm: "" },
    name: name ?? adapter,
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: modalities,
      output: modalities,
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
  }
}

export * as MergeModel from "./model"
