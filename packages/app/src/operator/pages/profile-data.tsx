import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "./config-helpers"
import type { Group, Layer, Profile } from "./profile-model"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Built-in layers, groups and profiles whose names are translated; the rest show their own names.
const NAMED_LAYERS = [
  "slot.base",
  "slot.agent",
  "purpose.org",
  "purpose.goal",
  "identity.shared",
  "generated.environment",
  "generated.references",
  "generated.instructions",
  "generated.mcp",
  "generated.skills",
]

// The server-wide prompt profile resources, shared by the Prompt Profile views.
export function usePromptProfile() {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const language = useLanguage()
  const query = useQuery(() => ({
    queryKey: api.key("prompt-profile"),
    queryFn: () =>
      api
        .client()
        .operator.promptProfile.catalog()
        .then((result) => result.data!),
  }))
  return {
    query,
    // After a change: the catalog and every preview (which it feeds) are stale.
    refresh: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: api.key("prompt-profile") }),
        queryClient.invalidateQueries({ queryKey: api.key("prompt-preview") }),
      ]),
    fail: (error: unknown) =>
      showToast({ title: language.t("operator.profile.saveFailed"), description: requestError(error) }),
  }
}

export function useProfileNames() {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Key)
  return {
    layer: (layer: Pick<Layer, "id" | "name">) =>
      NAMED_LAYERS.includes(layer.id) ? t(`operator.layer.${layer.id}`) : layer.name,
    // What a built-in layer is for, or undefined for layers people write.
    describe: (layer: Pick<Layer, "id" | "origin">) => {
      if (layer.origin === "builtin" && layer.id.startsWith("tool.")) return undefined
      if (layer.origin === "builtin") return t(`operator.prompts.id.${layer.id}`)
      if (NAMED_LAYERS.includes(layer.id)) return t(`operator.layer.about.${layer.id}`)
      return undefined
    },
    group: (group: Pick<Group, "id" | "name" | "builtin">) =>
      group.builtin ? t(`operator.group.${group.id}`) : group.name,
    profile: (profile: Pick<Profile, "id" | "name" | "builtin">) =>
      profile.builtin ? t(`operator.profileName.${profile.id}`) : profile.name,
    section: (section: string) => t(`operator.layerSection.${section}`),
    type: (type: string) => t(`operator.groupType.${type}`),
  }
}
