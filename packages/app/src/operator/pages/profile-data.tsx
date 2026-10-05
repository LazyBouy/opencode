import { useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useOperatorProjects } from "../project"
import { requestError } from "./config-helpers"
import { type Catalog, type Group, type Layer, OPENCODE, PREFIX, type Profile } from "./profile-model"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Built-in layers whose names are translated; OpenCode's texts show their ids.
const NAMED_LAYERS = [
  "slot.base",
  "slot.agent-or-base",
  "slot.agent",
  "generated.mcp",
  "generated.skills",
  "generated.environment",
  "generated.references",
  "generated.instructions",
  "purpose.org",
]

// The namespace a Prompt Profile view shows, kept in the URL as ?ns=.
export function useNamespaceParam() {
  const [params, setParams] = useSearchParams<{ ns?: string }>()
  return { ns: () => params.ns || OPENCODE, setNs: (ns: string) => setParams({ ns }) }
}

export function useNamespaces() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("namespaces"),
    queryFn: () =>
      api
        .client()
        .operator.namespace.list()
        .then((result) => result.data ?? []),
  }))
}

// A namespace's prompt items, and helpers to refresh them after a change.
export function usePromptCatalog(ns: () => string) {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const language = useLanguage()
  const query = useQuery(() => ({
    queryKey: api.key("prompt-catalog", ns()),
    queryFn: () =>
      api
        .client()
        .operator.namespace.catalog({ ns: ns() })
        .then((result) => result.data!),
  }))
  return {
    query,
    // A change can affect any namespace's catalog, every preview and every agent's setting.
    refresh: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: api.key("prompt-catalog") }),
        queryClient.invalidateQueries({ queryKey: api.key("namespaces") }),
        queryClient.invalidateQueries({ queryKey: api.key("prompt-preview") }),
        queryClient.invalidateQueries({ queryKey: api.key("agent-prompt") }),
        queryClient.invalidateQueries({ queryKey: api.key("project-settings") }),
      ]),
    fail: (error: unknown) =>
      showToast({ title: language.t("operator.profile.saveFailed"), description: requestError(error) }),
  }
}

// Tool descriptions are built-in layers for every tool of a project, read from one project of the
// namespace (or any known project).
export function useToolLayers(catalog: () => Catalog | undefined) {
  const api = useOperatorClient()
  const known = useOperatorProjects()
  const folder = createMemo(() => catalog()?.projects[0]?.key ?? known()[0]?.directory)
  const query = useQuery(() => ({
    queryKey: api.key("tool-layers", folder()),
    enabled: !!folder(),
    queryFn: () =>
      api
        .client()
        .operator.prompt.catalog({ directory: folder() })
        .then((result) => result.data?.tools ?? []),
  }))
  return createMemo<Layer[]>(() =>
    (query.data ?? []).map((tool) => ({
      id: `${PREFIX}tool.${tool.id}`,
      name: `tool.${tool.id}`,
      type: "capabilities",
      section: "tool",
      text: tool.builtin,
      origin: "builtin",
      delivery: "tool",
    })),
  )
}

// Every layer of a namespace, with the tool descriptions.
export function useAllLayers(catalog: () => Catalog | undefined) {
  const tools = useToolLayers(catalog)
  return createMemo(() => [...(catalog()?.layers ?? []), ...tools()])
}

// Names of built-in types, layers, groups and profiles in the viewer's language.
export function useProfileNames() {
  const language = useLanguage()
  const t = (key: string) => language.t(key as Key)
  const suffix = (id: string) => id.slice(PREFIX.length)
  return {
    type: (type: { id: string; name: string; builtin?: boolean }) =>
      type.builtin === false ? type.name : t(`operator.type.${type.id}`),
    typeId: (catalog: Catalog | undefined, id: string) => {
      const found = catalog?.types.find((item) => item.id === id)
      return found ? (found.builtin ? t(`operator.type.${found.id}`) : found.name) : id
    },
    typeAbout: (type: { id: string; description: string; builtin: boolean }) =>
      type.builtin ? t(`operator.type.about.${type.id}`) : type.description,
    layer: (layer: Pick<Layer, "id" | "name">) =>
      NAMED_LAYERS.includes(suffix(layer.id)) && layer.id.startsWith(PREFIX)
        ? t(`operator.layer.${suffix(layer.id)}`)
        : layer.name,
    // What a built-in layer is for, or undefined for layers people write and tool descriptions.
    about: (layer: Pick<Layer, "id" | "origin" | "section">) => {
      if (!layer.id.startsWith(PREFIX) || layer.section === "tool") return undefined
      if (NAMED_LAYERS.includes(suffix(layer.id))) return t(`operator.layer.about.${suffix(layer.id)}`)
      return t(`operator.prompts.id.${suffix(layer.id)}`)
    },
    group: (group: Pick<Group, "id" | "name" | "builtin">) =>
      group.builtin ? t(`operator.group.${suffix(group.id).replace("group.", "")}`) : group.name,
    profile: (profile: Pick<Profile, "id" | "name" | "builtin">) =>
      profile.builtin ? t(`operator.profileName.${suffix(profile.id).replace("profile.", "")}`) : profile.name,
    section: (section: string) => t(`operator.layerSection.${section}`),
  }
}
