import { Icon } from "@opencode-ai/ui/icon"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type {
  OperatorModelSource,
  OperatorModelChain,
  OperatorModelEffective,
  OperatorNamespaceModels,
  OperatorNamespaceSummary,
} from "@opencode-ai/sdk/v2/client"
import { useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, For, type JSX, Show } from "solid-js"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { shortPath } from "../format"
import { requestError } from "../pages/config-helpers"
import { useNamespaces } from "../pages/profile-data"
import { useProjectSettings } from "../pages/project-prompt"
import { useOperatorProjects } from "../project"
import { useConfirm } from "./confirm"
import { FieldHelp } from "./field-help"
import { useProjectConfigWrite } from "./project-config-copy"
import { ModelWithSource } from "./prompt-trace"

// The default and small model by level (default_models_spec.md §3, §5): Settings (Global's config) → a namespace's
// config → a project's config → the environment, else OpenCode decides. Providers & Models shows the defaults in
// effect for the namespace in scope ("Defaults for …"), then *Models per project*: the namespace's row ("All
// projects (<namespace>'s config)", read-only for Global, whose config is Settings) and one row per project, each
// with a picker (Inherit, or a model of a connected provider) and a short "from" line. The long "how chosen" texts
// are in Settings → Models. A change says which file it writes before saving it; a project's first write gives
// it its own config (copy-on-write, without its namespace's model keys).

const INHERIT = "@inherit"
type Key = "model" | "small_model"
type Which = "model" | "small"
const keyOf = (which: Which): Key => (which === "model" ? "model" : "small_model")

/** A namespace's own chain (`namespace` absent: Settings'). */
export function useNamespaceModels(namespace: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("model-defaults", "namespace", namespace() ?? "settings"),
    queryFn: () =>
      api
        .client()
        .operator.model.namespace(namespace() ? { namespace: namespace() } : {})
        .then((result) => result.data as OperatorNamespaceModels),
  }))
}

/** A project's chain. */
export function useProjectModels(directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("model-defaults", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.model.defaults({ directory: directory() })
        .then((result) => result.data!),
  }))
}

// Every model of a connected provider, as provider/model, with its name and provider's name.
export function useConnectedModels(directory: () => string | undefined) {
  const api = useOperatorClient()
  const providers = useQuery(() => ({
    queryKey: api.key("providers", directory()),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: directory() })
        .then((result) => result.data!),
  }))
  return createMemo(() =>
    (ready(providers)?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        key: `${provider.id}/${model.id}`,
        name: model.name,
        provider: provider.name,
      })),
    ),
  )
}

/** The words for where a model comes from (§5.1, §5.3). */
export function useModelWords(models: () => ReadonlyArray<{ key: string; name: string; provider: string }>) {
  const language = useLanguage()
  const name = (value: string) => models().find((item) => item.key === value)?.name ?? value
  const full = (value: string) => {
    const found = models().find((item) => item.key === value)
    return found ? `${found.name} · ${found.provider}` : value
  }
  // "OpenCode's config", "Settings (Global's config)", "the environment (OPENCODE_CONFIG)", "OpenCode decides".
  const from = (effective: OperatorModelEffective, namespace: string) => {
    if (effective.from === "namespace") return language.t("operator.modelChain.fromNamespace", { namespace })
    if (effective.from === "settings") return language.t("operator.modelChain.fromSettings")
    if (effective.from === "project") return language.t("operator.modelChain.fromProject")
    if (effective.from === "environment")
      return language.t("operator.modelChain.fromEnvironment", { variable: effective.variable ?? "" })
    return language.t("operator.modelChain.decides")
  }
  // One sentence tracing the chain to the model in effect.
  const trace = (
    chain: OperatorModelChain,
    which: Which,
    namespace: string,
    level: "namespace" | "project" | "settings",
  ) => {
    const effective = chain.effective
    const what = language.t(which === "model" ? "operator.modelChain.whatModel" : "operator.modelChain.whatSmall")
    const model = full(effective.model) || "—"
    if (effective.from === "environment")
      return language.t("operator.modelChain.traceEnvironment", { variable: effective.variable ?? "", model })
    if (effective.from === "opencode")
      return language.t(
        which === "model"
          ? "operator.modelChain.traceDecides"
          : effective.rule === "default-model"
            ? "operator.modelChain.traceDecidesSmallDefault"
            : "operator.modelChain.traceDecidesSmall",
        { model },
      )
    if (effective.from === level)
      return language.t("operator.modelChain.traceSet", { level: from(effective, namespace), model })
    const here =
      level === "project"
        ? language.t("operator.modelChain.thisProject")
        : level === "namespace"
          ? language.t("operator.modelChain.fromNamespace", { namespace })
          : language.t("operator.modelChain.fromSettings")
    return language.t("operator.modelChain.traceInherited", {
      here,
      what,
      from: from(effective, namespace),
      model,
    })
  }
  return { name, full, from, trace }
}

/**
 * The model in effect, view-only, with its "from" line and the (i) trace: the "Defaults for …" block, the
 * project overlay, the namespace page and the agent page.
 */
export function ModelInEffect(props: {
  label: string
  which: Which
  chain: OperatorModelChain | undefined
  namespace: string
  level: "namespace" | "project" | "settings"
  models: () => ReadonlyArray<{ key: string; name: string; provider: string }>
  /** Opens Settings → Models when "Settings" is clicked. */
  onSettings?: () => void
}) {
  const language = useLanguage()
  const words = useModelWords(props.models)
  return (
    <>
      <dt>
        {props.label}
        <Show when={props.chain}>
          {(chain) => (
            <FieldHelp field={props.label} text={words.trace(chain(), props.which, props.namespace, props.level)} />
          )}
        </Show>
      </dt>
      <dd data-testid={`model-in-effect-${props.which}`}>
        <Show when={props.chain} fallback={language.t("common.loading")}>
          {(chain) => (
            <span class="flex flex-wrap items-center gap-2">
              <span>{words.full(chain().effective.model) || language.t("operator.modelSource.none")}</span>
              <span data-slot="operator-note">
                <Show
                  when={chain().effective.from === "settings" && props.onSettings}
                  fallback={
                    chain().effective.from === "opencode"
                      ? language.t("operator.modelChain.decides")
                      : language.t("operator.modelChain.fromLine", {
                          from: words.from(chain().effective, props.namespace),
                        })
                  }
                >
                  {language.t("operator.modelChain.fromPrefix")}{" "}
                  <button type="button" data-slot="operator-link" onClick={() => props.onSettings?.()}>
                    {language.t("operator.modelChain.settingsLink")}
                  </button>{" "}
                  {language.t("operator.modelChain.settingsSuffix")}
                </Show>
              </span>
              <Unavailable effective={chain().effective} />
            </span>
          )}
        </Show>
      </dd>
    </>
  )
}

function Unavailable(props: { effective: OperatorModelEffective }) {
  const language = useLanguage()
  return (
    <Show when={props.effective.unavailable}>
      <span
        data-slot="operator-note"
        data-warning
        data-testid="model-unavailable"
        class="inline-flex items-center gap-1"
      >
        <Icon name="warning" size="small" />
        {language.t("operator.settingsModels.unavailable")}
      </span>
    </Show>
  )
}

/** "Defaults for <namespace>" (§5.1): the default and small model in effect for the namespace in scope. */
export function DefaultsBlock(props: { namespace: OperatorNamespaceSummary | undefined; all: boolean }) {
  const language = useLanguage()
  const openSettings = useSettingsDialog("models")
  const id = () => (props.all ? undefined : props.namespace?.namespace.id)
  const chains = useNamespaceModels(id)
  const models = useConnectedModels(() => props.namespace?.defaultProject)
  const name = () => props.namespace?.namespace.name ?? ""
  const settings = () => props.all || ready(chains)?.settings
  return (
    <section data-component="operator-panel" data-testid="model-defaults-block">
      <h2 data-slot="operator-panel-title">
        {props.all
          ? language.t("operator.modelChain.defaultsInSettings")
          : language.t("operator.modelChain.defaultsFor", { namespace: name() })}
      </h2>
      <dl data-component="record-fields">
        <For each={["model", "small"] as Which[]}>
          {(which) => (
            <ModelInEffect
              label={language.t(which === "model" ? "operator.models.defaultModel" : "operator.models.smallModel")}
              which={which}
              chain={which === "model" ? ready(chains)?.chain.model : ready(chains)?.chain.small}
              namespace={name()}
              level={settings() ? "settings" : "namespace"}
              models={models}
              onSettings={() => openSettings()}
            />
          )}
        </For>
      </dl>
      <Show when={props.all}>
        <p data-slot="operator-note">{language.t("operator.modelChain.allNote")}</p>
      </Show>
    </section>
  )
}

// One picker and its "from" line: Inherit (the level above's model) or a model; a change writes this level's
// file after saying which, and Follow removes a project value equal to what it would inherit.
function ModelCell(props: {
  label: string
  which: Which
  chain: OperatorModelChain | undefined
  level: "namespace" | "project"
  namespace: string
  directory: string | undefined
  /** The namespace the row writes (level namespace). */
  namespaceId?: string
  file: string | undefined
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const copyWrite = useProjectConfigWrite()
  const models = useConnectedModels(() => props.directory)
  const words = useModelWords(models)
  const link = () => props.chain?.levels.find((item) => item.level === props.level)
  const own = () => (link()?.set ? link()!.model : undefined)
  const inherited = () => props.chain?.inherited
  // Only a model shown in the chat's picker can be a default (Settings → Models' Show); the level's own stays listed.
  const visibility = useModels()
  const shown = (key: string) => {
    const at = key.indexOf("/")
    return key === own() || visibility.visible({ providerID: key.slice(0, at), modelID: key.slice(at + 1) })
  }
  const options = () => [
    INHERIT,
    ...models()
      .filter((model) => shown(model.key))
      .map((model) => model.key),
  ]
  const optionLabel = (key: string) => {
    if (key !== INHERIT) return words.name(key)
    const found = inherited()
    if (!found) return language.t("operator.modelChain.inherit")
    return found.from === "opencode"
      ? language.t("operator.modelChain.inheritDecides", { model: words.name(found.model) || "—" })
      : language.t("operator.modelChain.inheritFrom", {
          model: words.name(found.model),
          level: words.from(found, props.namespace),
        })
  }
  const write = async (model: string | null) => {
    const key = keyOf(props.which)
    const ok = await confirm({
      title: language.t("operator.modelDefaults.confirmTitle", { what: props.label }),
      description: language.t(model ? "operator.modelDefaults.confirmSet" : "operator.modelDefaults.confirmClear", {
        key,
        model: model ?? "",
        file: props.file ? shortPath(props.file) : "",
      }),
      confirm: language.t("operator.modelDefaults.save"),
    })
    if (!ok) return
    const send = (confirmCopy?: "true") =>
      api.client().operator.model.write(
        {
          level: props.level,
          ...(props.level === "namespace" ? { namespace: props.namespaceId } : { directory: props.directory }),
          key,
          // null removes the key (the generated client types drop it)
          model: model as string,
          ...(confirmCopy ? { confirmCopy: true } : {}),
        },
        { throwOnError: true },
      )
    await (props.level === "project" ? copyWrite(send) : send())
      .then(async (result) => {
        if (!result) return
        showToast({
          title: language.t("operator.modelDefaults.saved"),
          description:
            result.data?.reload === "when-idle" ? language.t("operator.modelDefaults.savedWhenIdle") : undefined,
        })
        await queryClient.invalidateQueries({ queryKey: api.key() })
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.models.setFailed"), description: requestError(error) }),
      )
  }
  const choose = (key: string) => {
    if ((key === INHERIT && !own()) || key === own()) return
    void write(key === INHERIT ? null : key)
  }
  const fromLine = (): JSX.Element => {
    const chain = props.chain
    if (!chain) return ""
    const effective = chain.effective
    if (effective.from === "environment")
      return language.t("operator.modelChain.overridden", { variable: effective.variable ?? "" })
    const here =
      props.level === "project"
        ? language.t("operator.modelChain.setProject")
        : language.t("operator.modelChain.setNamespace", { namespace: props.namespace })
    if (own()) {
      const parent = inherited()
      if (props.level === "project" && parent && parent.from !== "opencode" && parent.model === own())
        return (
          <>
            {language.t("operator.modelChain.sameAs", { level: words.from(parent, props.namespace) })} ·{" "}
            <button type="button" data-slot="operator-link" onClick={() => void write(null)}>
              {language.t("operator.modelChain.follow", { level: words.from(parent, props.namespace) })}
            </button>
          </>
        )
      return here
    }
    if (effective.from === "opencode") return language.t("operator.modelChain.decides")
    return language.t("operator.modelChain.fromInherited", { from: words.from(effective, props.namespace) })
  }
  return (
    <div class="flex flex-col gap-1">
      <SelectV2<string>
        appearance="base"
        aria-label={props.label}
        options={options()}
        current={own() ?? INHERIT}
        label={optionLabel}
        groupBy={(key) => (key === INHERIT ? "" : (models().find((model) => model.key === key)?.provider ?? ""))}
        onSelect={(key) => key && choose(key)}
      />
      <span data-slot="operator-note" data-testid="model-from">
        {fromLine()}
      </span>
      <Show when={props.chain}>{(chain) => <Unavailable effective={chain().effective} />}</Show>
    </div>
  )
}

// The project overlay's Models section, view-only (§7): the models in effect, with a link to the project's row.
export function ProjectModels(props: { directory: string; namespace: string; namespaceName: string }) {
  const language = useLanguage()
  const openSettings = useSettingsDialog("models")
  const chains = useProjectModels(() => props.directory)
  const models = useConnectedModels(() => props.directory)
  const href = () =>
    `/operator/models?ns=${encodeURIComponent(props.namespace)}&project=${encodeURIComponent(props.directory)}`
  return (
    <div class="flex flex-col gap-2" data-testid="project-models">
      <dl data-component="record-fields">
        <For each={["model", "small"] as Which[]}>
          {(which) => (
            <ModelInEffect
              label={language.t(which === "model" ? "operator.models.defaultModel" : "operator.models.smallModel")}
              which={which}
              chain={which === "model" ? ready(chains)?.chain.model : ready(chains)?.chain.small}
              namespace={props.namespaceName}
              level="project"
              models={models}
              onSettings={() => openSettings()}
            />
          )}
        </For>
      </dl>
      <a href={href()} data-slot="operator-link">
        {language.t("operator.modelChain.change")}
      </a>
    </div>
  )
}

// The table on Providers & Models: per namespace in scope, its own row, then its projects.
export function ModelsPerProject(props: { namespaces: ReadonlyArray<OperatorNamespaceSummary>; grouped: boolean }) {
  const language = useLanguage()
  const projects = useOperatorProjects()
  const [params] = useSearchParams<{ project?: string; row?: string }>()
  const labelOf = (key: string) =>
    projects().find((project) => project.directory === key)?.label ?? key.split(/[\\/]/).filter(Boolean).at(-1) ?? key
  // A link that names a row (?project=, or ?row=namespace for the namespace's own) shows it.
  createEffect(() => {
    const wanted = params.project
      ? `[data-testid="models-row"][data-project="${CSS.escape(params.project)}"]`
      : params.row === "namespace"
        ? '[data-testid="models-row-namespace"]'
        : undefined
    if (!wanted) return
    queueMicrotask(() => document.querySelector(wanted)?.scrollIntoView({ block: "center" }))
  })
  return (
    <section data-component="operator-panel" data-testid="models-per-project">
      <h2 data-slot="operator-panel-title">
        {language.t("operator.modelDefaults.title")}
        <FieldHelp
          field={language.t("operator.modelDefaults.title")}
          text={language.t("operator.help.modelsPerProject")}
        />
      </h2>
      <table data-component="operator-table" aria-label={language.t("operator.modelDefaults.title")}>
        <thead>
          <tr>
            <th scope="col">{language.t("operator.column.project")}</th>
            <th scope="col">{language.t("operator.models.defaultModel")}</th>
            <th scope="col">{language.t("operator.models.smallModel")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.namespaces}>
            {(item) => (
              <>
                <NamespaceRow
                  summary={item}
                  highlighted={params.row === "namespace" && !params.project && !props.grouped}
                />
                <For
                  each={item.projects}
                  fallback={
                    <tr>
                      <td colSpan={3}>
                        <span data-slot="operator-note">
                          {language.t("operator.modelDefaults.noProjects", { namespace: item.namespace.name })}
                        </span>
                      </td>
                    </tr>
                  }
                >
                  {(key) => (
                    <ProjectRow
                      directory={key}
                      label={labelOf(key)}
                      namespace={item.namespace.name}
                      highlighted={params.project === key}
                    />
                  )}
                </For>
              </>
            )}
          </For>
        </tbody>
      </table>
    </section>
  )
}

// The namespace's own row: its config's default and small model; for Global (or Global · OpenCode), whose
// config is Settings, read-only with a way to Settings → Models.
function NamespaceRow(props: { summary: OperatorNamespaceSummary; highlighted: boolean }) {
  const language = useLanguage()
  const openSettings = useSettingsDialog("models")
  const chains = useNamespaceModels(() => props.summary.namespace.id)
  const models = useConnectedModels(() => props.summary.defaultProject)
  const words = useModelWords(models)
  const name = () => props.summary.namespace.name
  const settings = () => props.summary.global || ready(chains)?.settings
  return (
    <tr
      data-testid="models-row-namespace"
      data-namespace={props.summary.namespace.id}
      data-highlighted={props.highlighted ? "" : undefined}
    >
      <th scope="row">
        {settings()
          ? language.t("operator.modelDefaults.allProjectsSettings")
          : language.t("operator.modelDefaults.allProjects", { namespace: name() })}
      </th>
      <For each={["model", "small"] as Which[]}>
        {(which) => {
          const chain = () => (which === "model" ? ready(chains)?.chain.model : ready(chains)?.chain.small)
          const label = () =>
            language.t("operator.modelDefaults.picker", {
              what: language.t(which === "model" ? "operator.models.defaultModel" : "operator.models.smallModel"),
              project: settings()
                ? language.t("operator.modelDefaults.allProjectsSettings")
                : language.t("operator.modelDefaults.allProjects", { namespace: name() }),
            })
          return (
            <td>
              <Show
                when={!settings()}
                fallback={
                  <div class="flex flex-col gap-1">
                    <span>{chain() ? words.full(chain()!.effective.model) || "—" : ""}</span>
                    <button type="button" data-slot="operator-link" onClick={() => openSettings()}>
                      {language.t("operator.modelDefaults.changeInSettings")}
                    </button>
                  </div>
                }
              >
                <ModelCell
                  label={label()}
                  which={which}
                  chain={chain()}
                  level="namespace"
                  namespace={name()}
                  namespaceId={props.summary.namespace.id}
                  directory={props.summary.defaultProject}
                  file={ready(chains)?.path}
                />
              </Show>
            </td>
          )
        }}
      </For>
    </tr>
  )
}

function ProjectRow(props: { directory: string; label: string; namespace: string; highlighted: boolean }) {
  const language = useLanguage()
  const chains = useProjectModels(() => props.directory)
  const file = () => ready(chains)?.chain.model.levels.find((item) => item.level === "project")?.path
  return (
    <tr data-testid="models-row" data-project={props.directory} data-highlighted={props.highlighted ? "" : undefined}>
      <th scope="row" title={props.directory}>
        {props.label}
      </th>
      <Show when={ready(chains)} fallback={<td colSpan={2}>{language.t("common.loading")}</td>}>
        {(found) => (
          <For each={["model", "small"] as Which[]}>
            {(which) => (
              <td>
                <ModelCell
                  label={language.t("operator.modelDefaults.picker", {
                    what: language.t(which === "model" ? "operator.models.defaultModel" : "operator.models.smallModel"),
                    project: props.label,
                  })}
                  which={which}
                  chain={which === "model" ? found().chain.model : found().chain.small}
                  level="project"
                  namespace={props.namespace}
                  directory={props.directory}
                  file={file()}
                />
              </td>
            )}
          </For>
        )}
      </Show>
    </tr>
  )
}

/** The models in effect for the namespace in scope, for the model list's Default and Small tags (§5.4). */
export function useEffectiveDefaults(namespace: () => string | undefined) {
  const chains = useNamespaceModels(namespace)
  return () => {
    const found = ready(chains)
    return found ? { model: found.chain.model.effective, small: found.chain.small.effective } : undefined
  }
}

/** A namespace's default and small model in effect, view-only (Settings → Namespaces, §7). */
export function NamespaceModels(props: { summary: OperatorNamespaceSummary }) {
  const language = useLanguage()
  const chains = useNamespaceModels(() => props.summary.namespace.id)
  const models = useConnectedModels(() => props.summary.defaultProject)
  const settings = () => props.summary.global || ready(chains)?.settings
  return (
    <For each={["model", "small"] as Which[]}>
      {(which) => (
        <ModelInEffect
          label={language.t(which === "model" ? "operator.models.defaultModel" : "operator.models.smallModel")}
          which={which}
          chain={which === "model" ? ready(chains)?.chain.model : ready(chains)?.chain.small}
          namespace={props.summary.namespace.name}
          level={settings() ? "settings" : "namespace"}
          models={models}
        />
      )}
    </For>
  )
}

/**
 * An agent's model on its page (§7): its own model, or, for an agent without one (OpenCode's built-ins), the
 * project's default model and where it comes from (the small model for the title agent).
 */
export function AgentModel(props: {
  source: OperatorModelSource | undefined
  directory: string
  /** It runs on the small model (`modelSource: "small"`): its model follows the project's small model. */
  small?: boolean
  /** The variant cleared when the small model changed to one without it. */
  cleared?: { variant: string; model: string }
}) {
  const language = useLanguage()
  const chains = useProjectModels(() => props.directory)
  const models = useConnectedModels(() => props.directory)
  const words = useModelWords(models)
  const settings = useProjectSettings()
  const namespaces = useNamespaces()
  const namespace = () => {
    const id = ready(settings)?.find((item) => item.key === props.directory)?.namespace
    return ready(namespaces)?.find((item) => item.namespace.id === id)?.namespace.name ?? id ?? ""
  }
  // Its own model, or its own model standing in for an unavailable one: as before (an agent on the small model
  // shows the small model it follows).
  const own = () =>
    !props.small && (props.source?.source === "agent" || !!props.source?.agent || props.source?.source === "chosen")
  const small = () => props.small || props.source?.source === "small" || props.source?.source === "small-family"
  return (
    <>
      <Show when={!own() && ready(chains)} fallback={<ModelWithSource source={props.source} />}>
        {(found) => {
          const effective = () => (small() ? found().chain.small.effective : found().chain.model.effective)
          return (
            <span class="flex flex-col gap-0.5" data-testid="agent-model">
              <span>
                {language.t(
                  props.small
                    ? "operator.agentModel.smallCurrent"
                    : small()
                      ? "operator.modelChain.agentSmall"
                      : "operator.modelChain.agentDefault",
                  { model: words.full(effective().model) || language.t("operator.modelSource.none") },
                )}
              </span>
              <span data-slot="operator-note">
                {effective().from === "opencode"
                  ? language.t("operator.modelChain.decides")
                  : language.t("operator.modelChain.fromLine", { from: words.from(effective(), namespace()) })}
              </span>
              <Unavailable effective={effective()} />
            </span>
          )
        }}
      </Show>
      <Show when={props.cleared}>
        {(cleared) => (
          <p data-slot="operator-note" data-warning role="status" data-testid="agent-variant-cleared">
            {language.t("operator.agentModel.variantCleared", {
              variant: cleared().variant,
              model: words.full(cleared().model),
            })}
          </p>
        )}
      </Show>
    </>
  )
}
