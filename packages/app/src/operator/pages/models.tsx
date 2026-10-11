import { useSearchParams } from "@solidjs/router"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { Model } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatCost, formatCount, shortPath } from "../format"
import { type Column, DataTable } from "../ui/data-table"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { NamespacePicker, useNamespaceScope } from "../ui/namespace-picker"
import { OPENCODE } from "./profile-model"
import { useOverlayParams } from "../ui/overlay-nav"
import { DefaultsBlock, ModelsPerProject, useEffectiveDefaults, useModelWords } from "../ui/model-defaults"

type Row = Model & { providerName: string; isDefault: boolean; isSmall: boolean }

// The providers and models the page lists are those of the namespace's default project (with every
// namespace in scope, OpenCode's), or the server's own when the namespace has no project. Default and
// Small mark the models in effect for the namespace in scope (with every namespace in scope, Settings'):
// default_models_spec.md §5.4.
function useModels() {
  const api = useOperatorClient()
  const scope = useNamespaceScope()
  const namespace = () =>
    scope.all()
      ? (scope.namespaces().find((item) => item.namespace.id === OPENCODE) ?? scope.namespaces()[0])
      : scope.scoped()[0]
  const directory = () => namespace()?.defaultProject
  const effective = useEffectiveDefaults(() => (scope.all() ? undefined : scope.scoped()[0]?.namespace.id))
  const providers = useQuery(() => ({
    queryKey: api.key("providers", directory()),
    queryFn: () =>
      api
        .client()
        .config.providers({ directory: directory() })
        .then((result) => result.data!),
  }))
  const rows = createMemo<Row[]>(() =>
    (providers.data?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        ...model,
        providerName: provider.name,
        isDefault: effective()?.model.model === `${provider.id}/${model.id}`,
        isSmall: effective()?.small.model === `${provider.id}/${model.id}`,
      })),
    ),
  )
  const connected = createMemo(() =>
    (providers.data?.providers ?? []).flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        key: `${provider.id}/${model.id}`,
        name: model.name,
        provider: provider.name,
      })),
    ),
  )
  return { providers, rows, effective, connected, directory, scope, namespace }
}

type Effective = ReturnType<ReturnType<typeof useEffectiveDefaults>>
type Words = ReturnType<typeof useModelWords>

// The Default and Small tags, with where the model in effect comes from in their tooltip.
function DefaultTags(props: { row: Row; namespace: string; effective: Effective; words: Words }) {
  const language = useLanguage()
  const effective = () => props.effective
  const words = props.words
  return (
    <>
      <Show when={props.row.isDefault && effective()}>
        {(found) => (
          <span
            title={language.t("operator.modelChain.tagDefault", {
              namespace: props.namespace,
              from: words.from(found().model, props.namespace),
            })}
          >
            <Tag variant="accent">{language.t("operator.models.default")}</Tag>
          </span>
        )}
      </Show>
      <Show when={props.row.isSmall && effective()}>
        {(found) => (
          <span
            title={language.t("operator.modelChain.tagSmall", {
              namespace: props.namespace,
              from: words.from(found().small, props.namespace),
            })}
          >
            <Tag>{language.t("operator.models.small")}</Tag>
          </span>
        )}
      </Show>
    </>
  )
}

// A model opens in the overlay (`model`, as provider/model): the providers on the left.
export default function ModelsPage() {
  const language = useLanguage()
  const connect = useSettingsDialog("providers")
  const choose = useSettingsDialog("models")
  const [filter, setFilter] = createStore({ text: "" })
  const { providers, rows, directory, scope, effective, connected } = useModels()
  const words = useModelWords(connected)
  const inScope = () =>
    scope.all() ? language.t("operator.modelChain.settingsName") : (scope.scoped()[0]?.namespace.name ?? "")
  const [params, setParams] = useSearchParams<{ model?: string }>()
  useRecordOverlay(
    () => !!params.model,
    () => <ModelOverlay />,
    ["model"],
  )
  const locale = () => language.intl()
  const perMillion = (value: number) => (value ? formatCost(value, locale()) : "—")

  const columns: Column<Row>[] = [
    {
      id: "model",
      header: language.t("operator.column.model"),
      value: (model) => model.name,
      cell: (model) => (
        <span class="flex items-center gap-2">
          <ProviderIcon id={model.providerID} width={14} height={14} class="shrink-0" />
          {model.name}
          <DefaultTags row={model} namespace={inScope()} effective={effective()} words={words} />
        </span>
      ),
    },
    {
      id: "provider",
      header: language.t("operator.column.provider"),
      value: (model) => model.providerName,
      cell: (model) => model.providerName,
    },
    {
      id: "context",
      optional: true,
      header: language.t("operator.models.context"),
      align: "end",
      value: (model) => model.limit.context,
      cell: (model) => formatCount(model.limit.context, locale()),
    },
    {
      id: "output",
      optional: true,
      header: language.t("operator.models.output"),
      align: "end",
      value: (model) => model.limit.output,
      cell: (model) => formatCount(model.limit.output, locale()),
    },
    {
      id: "input",
      optional: true,
      header: language.t("operator.models.inputPrice"),
      align: "end",
      value: (model) => model.cost.input,
      cell: (model) => perMillion(model.cost.input),
    },
    {
      id: "outputPrice",
      optional: true,
      header: language.t("operator.models.outputPrice"),
      align: "end",
      value: (model) => model.cost.output,
      cell: (model) => perMillion(model.cost.output),
    },
    {
      id: "cache",
      optional: true,
      hidden: true,
      header: language.t("operator.models.cachePrice"),
      align: "end",
      value: (model) => model.cost.cache.read,
      cell: (model) => perMillion(model.cost.cache.read),
    },
    {
      id: "capabilities",
      optional: true,
      header: language.t("operator.models.capabilities"),
      cell: (model) => (
        <span class="flex flex-wrap gap-1">
          <Show when={model.capabilities.reasoning}>
            <Tag>{language.t("operator.models.reasoning")}</Tag>
          </Show>
          <Show when={model.capabilities.input.image}>
            <Tag>{language.t("operator.models.images")}</Tag>
          </Show>
          <Show when={model.capabilities.toolcall}>
            <Tag>{language.t("operator.models.tools")}</Tag>
          </Show>
        </span>
      ),
    },
    {
      id: "released",
      optional: true,
      header: language.t("operator.models.released"),
      align: "end",
      value: (model) => model.release_date,
      cell: (model) => model.release_date,
    },
  ]

  return (
    <>
      <PageHeader
        title={language.t("operator.page.models.title")}
        description={language.t("operator.page.models.description")}
        actions={
          <>
            <NamespacePicker />
            <ButtonV2 size="small" variant="outline" onClick={() => choose()}>
              {language.t("operator.models.choose")}
            </ButtonV2>
            <ButtonV2 size="small" variant="contrast" onClick={() => connect()}>
              {language.t("operator.models.connect")}
            </ButtonV2>
          </>
        }
      />
      <DefaultsBlock namespace={scope.all() ? undefined : scope.scoped()[0]} all={scope.all()} />
      <ModelsPerProject namespaces={scope.scoped()} grouped={scope.all() && scope.namespaces().length > 1} />
      <div data-slot="operator-tiles">
        <For each={providers.data?.providers ?? []}>
          {(provider) => (
            <div data-component="operator-stat">
              <div data-slot="operator-stat-label" class="flex items-center gap-2">
                <ProviderIcon id={provider.id} width={14} height={14} />
                {provider.name}
              </div>
              <div data-slot="operator-stat-value">{formatCount(Object.keys(provider.models).length, locale())}</div>
              <div data-slot="operator-stat-hint">
                {language.t("operator.models.providerHint", {
                  source: language.t(`operator.models.source.${provider.source}`),
                })}
              </div>
            </div>
          )}
        </For>
      </div>
      <p data-slot="operator-note" data-testid="models-listed-from">
        {directory()
          ? language.t("operator.models.listedFrom", { project: shortPath(directory()!) })
          : language.t("operator.models.listedFromServer")}{" "}
        {language.t("operator.models.priceNote")}
      </p>
      <div data-slot="operator-toolbar">
        <TextInputV2
          type="search"
          appearance="base"
          value={filter.text}
          onInput={(event) => setFilter("text", event.currentTarget.value)}
          placeholder={language.t("operator.models.search")}
          aria-label={language.t("operator.models.search")}
        />
      </div>
      <DataTable
        columnsKey="models"
        label={language.t("operator.page.models.title")}
        rows={rows()}
        columns={columns}
        filter={filter.text}
        search={(model) => `${model.name} ${model.id} ${model.providerName}`}
        loading={providers.isPending}
        empty={language.t("operator.models.empty")}
        initialSort={{ column: "provider", direction: "asc" }}
        onRowClick={(model) => setParams({ model: `${model.providerID}/${model.id}` })}
      />
    </>
  )
}

// The overlay a model opens in: the providers on the left, a model's limits, prices and capabilities.
function ModelOverlay() {
  const language = useLanguage()
  const { providers, rows, scope, effective, connected } = useModels()
  const words = useModelWords(connected)
  const [params, setParams] = useOverlayParams<{ model?: string }>()
  const inScope = () =>
    scope.all() ? language.t("operator.modelChain.settingsName") : (scope.scoped()[0]?.namespace.name ?? "")
  const locale = () => language.intl()
  const perMillion = (value: number) => (value ? formatCost(value, locale()) : "—")
  const keyOf = (model: Row) => `${model.providerID}/${model.id}`
  const model = createMemo(() => rows().find((item) => keyOf(item) === params.model))
  const blocks = createMemo<OverlayBlock[]>(() =>
    (providers.data?.providers ?? []).map((provider) => ({
      id: provider.id,
      label: provider.name,
      icon: "models",
      records: rows()
        .filter((item) => item.providerID === provider.id)
        .map((item) => ({ id: keyOf(item), label: item.name, detail: item.id })),
    })),
  )
  const yes = (value: boolean) => (value ? language.t("operator.models.yes") : language.t("operator.models.no"))

  return (
    <RecordOverlay
      title={language.t("operator.page.models.title")}
      namespaces={[]}
      blocks={blocks()}
      block={model()?.providerID ?? blocks()[0]?.id ?? ""}
      record={params.model}
      editing={false}
      onBlock={(id) => setParams({ model: blocks().find((block) => block.id === id)?.records[0]?.id })}
      onRecord={(_, id) => setParams({ model: id })}
    >
      <Show when={model()} fallback={<p data-slot="operator-note">{language.t("operator.models.empty")}</p>}>
        {(found) => (
          <RecordView
            title={
              <>
                {found().name}
                <DefaultTags row={found()} namespace={inScope()} effective={effective()} words={words} />
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField
                label={language.t("operator.modelChain.defaultFor")}
                help={language.t("operator.help.modelDefaultFor")}
              >
                <DefaultFor model={keyOf(found())} />
              </RecordField>
              <RecordField
                label={language.t("operator.column.provider")}
                help={language.t("operator.help.modelProvider")}
              >
                {found().providerName} · <code>{found().id}</code>
              </RecordField>
              <RecordField
                label={language.t("operator.models.context")}
                help={language.t("operator.help.modelContext")}
              >
                {formatCount(found().limit.context, locale())}
              </RecordField>
              <RecordField label={language.t("operator.models.output")} help={language.t("operator.help.modelOutput")}>
                {formatCount(found().limit.output, locale())}
              </RecordField>
              <RecordField
                label={language.t("operator.models.inputPrice")}
                help={language.t("operator.help.modelPrice")}
              >
                {perMillion(found().cost.input)}
              </RecordField>
              <RecordField
                label={language.t("operator.models.outputPrice")}
                help={language.t("operator.help.modelPrice")}
              >
                {perMillion(found().cost.output)}
              </RecordField>
              <RecordField
                label={language.t("operator.models.cachePrice")}
                help={language.t("operator.help.modelPrice")}
              >
                {perMillion(found().cost.cache.read)}
              </RecordField>
              <RecordField
                label={language.t("operator.models.reasoning")}
                help={language.t("operator.help.modelCapability")}
              >
                {yes(found().capabilities.reasoning)}
              </RecordField>
              <RecordField
                label={language.t("operator.models.images")}
                help={language.t("operator.help.modelCapability")}
              >
                {yes(found().capabilities.input.image)}
              </RecordField>
              <RecordField
                label={language.t("operator.models.tools")}
                help={language.t("operator.help.modelCapability")}
              >
                {yes(found().capabilities.toolcall)}
              </RecordField>
              <RecordField
                label={language.t("operator.models.released")}
                help={language.t("operator.help.modelReleased")}
              >
                {found().release_date || "—"}
              </RecordField>
            </dl>
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}

// Where a model is the default or the small model (§5.4): Settings, namespaces and projects whose config sets it,
// each with a way to its row.
function DefaultFor(props: { model: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const openSettings = useSettingsDialog("models")
  const found = useQuery(() => ({
    queryKey: api.key("model-default-for", props.model),
    queryFn: () =>
      api
        .client()
        .operator.model.defaultFor({ model: props.model })
        .then((result) => result.data!),
  }))
  const role = (item: { model: boolean; small: boolean }) =>
    [
      item.model ? language.t("operator.modelChain.roleDefault") : undefined,
      item.small ? language.t("operator.modelChain.roleSmall") : undefined,
    ]
      .filter(Boolean)
      .join(", ")
  const places = () => {
    const data = found.data
    if (!data) return 0
    return (data.settings ? 1 : 0) + data.namespaces.length + data.projects.length
  }
  return (
    <Show when={found.data} fallback={language.t("common.loading")}>
      {(data) => (
        <Show
          when={places()}
          fallback={<span data-slot="operator-note">{language.t("operator.modelChain.defaultForNone")}</span>}
        >
          <ul data-testid="model-default-for" class="flex flex-col gap-1">
            <Show when={data().settings}>
              {(settings) => (
                <li>
                  <button type="button" data-slot="operator-link" onClick={() => openSettings()}>
                    {language.t("operator.modelChain.settingsName")}
                  </button>{" "}
                  · {role(settings())}
                </li>
              )}
            </Show>
            <For each={data().namespaces}>
              {(item) => (
                <li>
                  <a
                    data-slot="operator-link"
                    href={`/operator/models?ns=${encodeURIComponent(item.id)}&row=namespace`}
                  >
                    {item.name}
                  </a>{" "}
                  · {role(item)}
                </li>
              )}
            </For>
            <For each={data().projects}>
              {(item) => (
                <li>
                  <a
                    data-slot="operator-link"
                    href={`/operator/models?ns=${encodeURIComponent(item.namespace)}&project=${encodeURIComponent(item.key)}`}
                    title={item.key}
                  >
                    {item.name}
                  </a>{" "}
                  · {role(item)}
                </li>
              )}
            </For>
          </ul>
        </Show>
      )}
    </Show>
  )
}
