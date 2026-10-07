import { useSearchParams } from "@solidjs/router"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { Model } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSettingsDialog } from "@/components/settings-dialog"
import { useLanguage } from "@/context/language"
import { useOperatorClient } from "../data"
import { formatCost, formatCount } from "../format"
import { useScopedProject } from "../project"
import { type Column, DataTable } from "../ui/data-table"
import { FieldHelp } from "../ui/field-help"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { ScopePicker } from "../ui/scope-picker"
import { type Scope, ScopeSwitch } from "../ui/scope-switch"
import { ModelWithSource } from "../ui/prompt-trace"
import { showToast } from "@/utils/toast"
import { requestError } from "./config-helpers"
import { useOverlayParams } from "../ui/overlay-nav"

type Row = Model & { providerName: string; isDefault: boolean; isSmall: boolean }

// The project's providers and their models, and its default and small model with where they are set.
function useModels() {
  const api = useOperatorClient()
  const directory = useScopedProject()
  const defaults = useQuery(() => ({
    queryKey: api.key("model-defaults", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.model.defaults({ directory: directory() })
        .then((result) => result.data!),
  }))
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
        isDefault: defaults.data?.model.model === `${provider.id}/${model.id}`,
        isSmall: defaults.data?.small.model === `${provider.id}/${model.id}`,
      })),
    ),
  )
  return { providers, rows, defaults, directory }
}

// Makes a model the default or the small model: config `model` / `small_model` at a scope.
function useSetModel() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  return async (directory: string | undefined, scope: Scope, key: "model" | "small_model", model: string) =>
    api
      .client()
      .operator.config.update({ directory, scope, body: { [key]: model } }, { throwOnError: true })
      .then(async () => {
        showToast({
          title: language.t(key === "model" ? "operator.models.defaultSet" : "operator.models.smallSet", { model }),
        })
        await queryClient.invalidateQueries({ queryKey: api.key() })
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.models.setFailed"), description: requestError(error) }),
      )
}

// A model opens in the overlay (`model`, as provider/model): the providers on the left.
export default function ModelsPage() {
  const language = useLanguage()
  const connect = useSettingsDialog("providers")
  const choose = useSettingsDialog("models")
  const [filter, setFilter] = createStore({ text: "" })
  const { providers, rows, defaults } = useModels()
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
          <Show when={model.isDefault}>
            <Tag variant="accent">{language.t("operator.models.default")}</Tag>
          </Show>
          <Show when={model.isSmall}>
            <Tag>{language.t("operator.models.small")}</Tag>
          </Show>
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
            <ScopePicker />
            <ButtonV2 size="small" variant="outline" onClick={() => choose()}>
              {language.t("operator.models.choose")}
            </ButtonV2>
            <ButtonV2 size="small" variant="contrast" onClick={() => connect()}>
              {language.t("operator.models.connect")}
            </ButtonV2>
          </>
        }
      />
      <section data-component="operator-panel" data-testid="model-defaults">
        <dl data-component="operator-facts" data-layout="stacked">
          <div data-slot="operator-fact">
            <dt>
              {language.t("operator.models.defaultModel")}
              <FieldHelp
                field={language.t("operator.models.defaultModel")}
                text={language.t("operator.help.defaultModel")}
              />
            </dt>
            <dd>
              <ModelWithSource source={defaults.data?.model} />
            </dd>
          </div>
          <div data-slot="operator-fact">
            <dt>
              {language.t("operator.models.smallModel")}
              <FieldHelp
                field={language.t("operator.models.smallModel")}
                text={language.t("operator.help.smallModel")}
              />
            </dt>
            <dd>
              <ModelWithSource source={defaults.data?.small} />
            </dd>
          </div>
        </dl>
      </section>
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
      <p data-slot="operator-note">{language.t("operator.models.priceNote")}</p>
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
  const { providers, rows, directory } = useModels()
  const setModel = useSetModel()
  const [scope, setScope] = createStore({ value: "global" as Scope, busy: false })
  const use = async (key: "model" | "small_model", model: string) => {
    setScope("busy", true)
    await setModel(directory(), scope.value, key, model).finally(() => setScope("busy", false))
  }
  const [params, setParams] = useOverlayParams<{ model?: string }>()
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
                <Show when={found().isDefault}>
                  <Tag variant="accent">{language.t("operator.models.default")}</Tag>
                </Show>
                <Show when={found().isSmall}>
                  <Tag>{language.t("operator.models.small")}</Tag>
                </Show>
              </>
            }
            actions={
              <>
                <ScopeSwitch value={scope.value} onChange={(value) => setScope("value", value)} />
                <ButtonV2
                  variant="outline"
                  disabled={scope.busy || found().isDefault}
                  onClick={() => void use("model", keyOf(found()))}
                >
                  {language.t("operator.models.useDefault")}
                </ButtonV2>
                <ButtonV2
                  variant="outline"
                  disabled={scope.busy || found().isSmall}
                  onClick={() => void use("small_model", keyOf(found()))}
                >
                  {language.t("operator.models.useSmall")}
                </ButtonV2>
              </>
            }
          >
            <dl data-component="record-fields">
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
