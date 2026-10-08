import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { OperatorModelSource, OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { shortPath } from "../format"
import { requestError } from "../pages/config-helpers"
import { useOperatorProjects } from "../project"
import { useConfirm } from "./confirm"
import { FieldHelp } from "./field-help"
import { useModelSourceText } from "./prompt-trace"

// The default and small model per project (fixes_spec.md §8): for every project, and for all of them
// (the global config), a picker for each — OpenCode's choice (no setting) or any model of a connected
// provider — and how each was chosen: set for this project, set globally, or OpenCode's choice with the
// rule that picked it. A change says which file it writes before saving it.

const OPENCODE = "@opencode"
type Key = "model" | "small_model"

function useProjectDefaults(directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("model-defaults", directory()),
    queryFn: () =>
      api
        .client()
        .operator.model.defaults({ directory: directory() })
        .then((result) => result.data!),
  }))
}

// The config files of a project (or of the server's own folder, for the global file).
function useLayers(directory: () => string | undefined) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("config-layers", directory()),
    queryFn: () =>
      api
        .client()
        .operator.config.layers({ directory: directory() })
        .then((result) => result.data!),
  }))
}

// Every model of a connected provider, as provider/model.
function useConnectedModels(directory: () => string | undefined) {
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
      Object.values(provider.models).map((model) => ({ key: `${provider.id}/${model.id}`, name: model.name })),
    ),
  )
}

export function useHowText() {
  const language = useLanguage()
  const sourceText = useModelSourceText()
  return (source: OperatorModelSource | undefined) => {
    if (!source) return ""
    if (source.how === "project")
      return language.t("operator.modelDefaults.how.project", { path: shortPath(source.path ?? "") })
    if (source.how === "global")
      return language.t("operator.modelDefaults.how.global", { path: shortPath(source.path ?? "") })
    return language.t("operator.modelDefaults.how.opencode", { rule: sourceText(source) })
  }
}

// One picker: OpenCode's choice or a model; changing it writes the key to the scope's file, after
// saying which file.
function ModelPicker(props: {
  label: string
  value: string | undefined
  scope: "project" | "global"
  directory: string | undefined
  configKey: Key
  file: string | undefined
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const models = useConnectedModels(() => props.directory)
  const options = () => [OPENCODE, ...models().map((model) => model.key)]
  const nameOf = (key: string) =>
    key === OPENCODE
      ? language.t("operator.modelDefaults.opencodeChoice")
      : (models().find((model) => model.key === key)?.name ?? key)
  const choose = async (key: string) => {
    if ((key === OPENCODE && !props.value) || key === props.value) return
    const ok = await confirm({
      title: language.t("operator.modelDefaults.confirmTitle", { what: props.label }),
      description: language.t(
        key === OPENCODE ? "operator.modelDefaults.confirmClear" : "operator.modelDefaults.confirmSet",
        { key: props.configKey, model: key, file: props.file ? shortPath(props.file) : "" },
      ),
      confirm: language.t("operator.modelDefaults.save"),
    })
    if (!ok) return
    await api
      .client()
      .operator.config.update(
        { directory: props.directory, scope: props.scope, body: { [props.configKey]: key === OPENCODE ? null : key } },
        { throwOnError: true },
      )
      .then(async (result) => {
        showToast({
          title: language.t("operator.modelDefaults.saved"),
          description:
            result.data?.reload === "when-idle" ? language.t("operator.modelDefaults.savedWhenIdle") : undefined,
        })
        await Promise.all(
          ["model-defaults", "config-layers", "config"].map((part) =>
            queryClient.invalidateQueries({ queryKey: api.key(part) }),
          ),
        )
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.models.setFailed"), description: requestError(error) }),
      )
  }
  return (
    <SelectV2<string>
      appearance="base"
      aria-label={props.label}
      options={options()}
      current={props.value ?? OPENCODE}
      label={nameOf}
      onSelect={(key) => key && void choose(key)}
    />
  )
}

// A project's two pickers (or the global ones), with how each model was chosen.
function useRow(directory: () => string | undefined) {
  const defaults = useProjectDefaults(directory)
  const layers = useLayers(directory)
  // What the global file sets (the first row: no project).
  const global = createMemo(() => {
    const value = ready(defaults)?.global
    return { model: value?.model, small: value?.small, path: value?.path }
  })
  return { defaults, layers, global }
}

export function ProjectModelPickers(props: { directory: string }) {
  const language = useLanguage()
  const how = useHowText()
  const row = useRow(() => props.directory)
  const value = (source: OperatorModelSource | undefined) => (source?.how === "project" ? source.model : undefined)
  const file = () => ready(row.layers)?.targets.project
  return (
    <dl data-component="record-fields" data-testid="project-models">
      <For each={["model", "small"] as const}>
        {(which) => {
          const source = () => ready(row.defaults)?.[which]
          const label = language.t(which === "model" ? "operator.models.defaultModel" : "operator.models.smallModel")
          return (
            <>
              <dt>
                {label}
                <FieldHelp
                  field={label}
                  text={language.t(which === "model" ? "operator.help.defaultModel" : "operator.help.smallModel")}
                />
              </dt>
              <dd class="flex flex-col gap-1">
                <ModelPicker
                  label={label}
                  value={value(source())}
                  scope="project"
                  directory={props.directory}
                  configKey={which === "model" ? "model" : "small_model"}
                  file={file()}
                />
                <span data-slot="operator-note" data-warning={source()?.source === "ranking" ? "" : undefined}>
                  {source() ? `${source()!.model || language.t("operator.modelSource.none")} · ${how(source())}` : ""}
                </span>
              </dd>
            </>
          )
        }}
      </For>
    </dl>
  )
}

// The table on Providers & Models: All projects (global), then the projects of the namespaces in
// scope, under each namespace's name when there are several.
export function ModelsPerProject(props: { namespaces: ReadonlyArray<OperatorNamespaceSummary>; grouped: boolean }) {
  const language = useLanguage()
  const projects = useOperatorProjects()
  const labelOf = (key: string) =>
    projects().find((project) => project.directory === key)?.label ?? key.split(/[\\/]/).filter(Boolean).at(-1) ?? key
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
            <th scope="col">{language.t("operator.modelDefaults.howChosen")}</th>
            <th scope="col">{language.t("operator.models.smallModel")}</th>
            <th scope="col">{language.t("operator.modelDefaults.howChosen")}</th>
          </tr>
        </thead>
        <tbody>
          <GlobalRow />
          <For each={props.namespaces}>
            {(item) => (
              <>
                <Show when={props.grouped}>
                  <tr data-testid="models-namespace">
                    <th scope="colgroup" colSpan={5}>
                      {item.namespace.name}
                    </th>
                  </tr>
                </Show>
                <For
                  each={item.projects}
                  fallback={
                    <tr>
                      <td colSpan={5}>
                        <span data-slot="operator-note">
                          {language.t("operator.modelDefaults.noProjects", { namespace: item.namespace.name })}
                        </span>
                      </td>
                    </tr>
                  }
                >
                  {(key) => <ProjectRow directory={key} label={labelOf(key)} />}
                </For>
              </>
            )}
          </For>
        </tbody>
      </table>
    </section>
  )
}

function Cells(props: {
  model: JSX.Element
  modelHow: string
  small: JSX.Element
  smallHow: string
  ranking?: boolean
}) {
  return (
    <>
      <td>{props.model}</td>
      <td>
        <span data-slot="operator-note" data-warning={props.ranking ? "" : undefined}>
          {props.modelHow}
        </span>
      </td>
      <td>{props.small}</td>
      <td>
        <span data-slot="operator-note">{props.smallHow}</span>
      </td>
    </>
  )
}

function GlobalRow() {
  const language = useLanguage()
  const row = useRow(() => undefined)
  const file = () => ready(row.layers)?.targets.global
  const how = (value: string | undefined) =>
    value
      ? language.t("operator.modelDefaults.how.global", { path: shortPath(row.global().path ?? file() ?? "") })
      : language.t("operator.modelDefaults.how.eachProject")
  return (
    <tr data-testid="models-row-global">
      <th scope="row">{language.t("operator.modelDefaults.allProjects")}</th>
      <Cells
        model={
          <ModelPicker
            label={language.t("operator.modelDefaults.pickerGlobal", {
              what: language.t("operator.models.defaultModel"),
            })}
            value={row.global().model}
            scope="global"
            directory={undefined}
            configKey="model"
            file={file()}
          />
        }
        modelHow={how(row.global().model)}
        small={
          <ModelPicker
            label={language.t("operator.modelDefaults.pickerGlobal", {
              what: language.t("operator.models.smallModel"),
            })}
            value={row.global().small}
            scope="global"
            directory={undefined}
            configKey="small_model"
            file={file()}
          />
        }
        smallHow={how(row.global().small)}
      />
    </tr>
  )
}

function ProjectRow(props: { directory: string; label: string }) {
  const language = useLanguage()
  const howText = useHowText()
  const row = useRow(() => props.directory)
  const defaults = () => ready(row.defaults)
  const value = (source: OperatorModelSource | undefined) => (source?.how === "project" ? source.model : undefined)
  const file = () => ready(row.layers)?.targets.project
  const shown = (source: OperatorModelSource | undefined) =>
    source ? `${source.model || language.t("operator.modelSource.none")} · ${howText(source)}` : ""
  return (
    <tr data-testid="models-row" data-project={props.directory}>
      <th scope="row" title={props.directory}>
        {props.label}
      </th>
      <Show when={defaults()} fallback={<td colSpan={4}>{language.t("common.loading")}</td>}>
        <Cells
          model={
            <ModelPicker
              label={language.t("operator.modelDefaults.picker", {
                what: language.t("operator.models.defaultModel"),
                project: props.label,
              })}
              value={value(defaults()?.model)}
              scope="project"
              directory={props.directory}
              configKey="model"
              file={file()}
            />
          }
          modelHow={shown(defaults()?.model)}
          ranking={defaults()?.model.source === "ranking"}
          small={
            <ModelPicker
              label={language.t("operator.modelDefaults.picker", {
                what: language.t("operator.models.smallModel"),
                project: props.label,
              })}
              value={value(defaults()?.small)}
              scope="project"
              directory={props.directory}
              configKey="small_model"
              file={file()}
            />
          }
          smallHow={shown(defaults()?.small)}
        />
      </Show>
    </tr>
  )
}
