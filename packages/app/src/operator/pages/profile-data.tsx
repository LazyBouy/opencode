import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { useOperatorProjects } from "../project"
import { requestError } from "./config-helpers"
import { ALL, type Catalog, type Group, type Layer, PREFIX, type Profile, OPENCODE } from "./profile-model"

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
]

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

// After a change: refresh what it can affect (every catalog, preview and setting), or report a failure.
export function usePromptRefresh() {
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const language = useLanguage()
  return {
    refresh: () =>
      Promise.all(
        ["prompt-catalog", "namespaces", "prompt-preview", "agent-prompt", "project-settings"].map((key) =>
          queryClient.invalidateQueries({ queryKey: api.key(key) }),
        ),
      ),
    fail: (error: unknown) =>
      showToast({ title: language.t("operator.profile.saveFailed"), description: requestError(error) }),
  }
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

// The catalogs of the namespaces in scope (all of them, or one), in the namespaces' order. Built-in
// items belong to OpenCode (other namespaces have their own copies); `scoped` lists each namespace's
// own items, and OpenCode's built-ins (with no namespace) when OpenCode is in scope.
export function useScopeCatalogs(ns: () => string, namespaces: () => ReadonlyArray<OperatorNamespaceSummary>) {
  const api = useOperatorClient()
  const ids = () => (ns() === ALL ? namespaces().map((item) => item.namespace.id) : [ns()])
  const query = useQuery(() => ({
    queryKey: api.key("prompt-catalog", "scope", ids()),
    enabled: ids().length > 0,
    queryFn: () =>
      Promise.all(
        ids().map((id) =>
          api
            .client()
            .operator.namespace.catalog({ ns: id })
            .then((result) => result.data!),
        ),
      ),
  }))
  const list = (): Catalog[] => query.data ?? []
  return {
    query,
    list,
    // The catalog that built-in items are read from (all have them).
    first: () => list()[0],
    of: (id: string | undefined) => (id ? list().find((catalog) => catalog.namespace.id === id) : undefined),
    // Items of every catalog: each namespace's own, then the built-ins once (with no namespace).
    scoped: <T extends { id: string }>(pick: (catalog: Catalog) => ReadonlyArray<T>, builtin: (item: T) => boolean) => {
      const all = list()
      const own = all.flatMap((catalog) =>
        pick(catalog)
          .filter((item) => !builtin(item))
          .map((item) => ({ ns: catalog.namespace.id as string | undefined, item })),
      )
      const opencode = all.find((catalog) => catalog.namespace.id === OPENCODE)
      const shared = opencode
        ? pick(opencode)
            .filter(builtin)
            .map((item) => ({ ns: undefined, item }))
        : []
      return [...shared, ...own]
    },
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

// Every layer of a namespace, with the tool descriptions in OpenCode (other namespaces hold their own
// copies of the ones they changed).
export function useAllLayers(catalog: () => Catalog | undefined) {
  const tools = useToolLayers(catalog)
  return createMemo(() => [...(catalog()?.layers ?? []), ...(catalog()?.namespace.id === OPENCODE ? tools() : [])])
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
