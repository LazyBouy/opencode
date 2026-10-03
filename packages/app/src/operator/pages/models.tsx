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
import { Persist, persisted } from "@/utils/persist"
import { useOperatorClient } from "../data"
import { formatCost, formatCount } from "../format"
import { useScopedProject } from "../project"
import { ColumnPicker } from "../ui/column-picker"
import { type Column, DataTable } from "../ui/data-table"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"

type Row = Model & { providerName: string; isDefault: boolean }

export default function ModelsPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const directory = useScopedProject()
  const connect = useSettingsDialog("providers")
  const choose = useSettingsDialog("models")
  const [prefs, setPrefs] = persisted(Persist.global("operator.models"), createStore({ hidden: ["cache"] as string[] }))
  const [filter, setFilter] = createStore({ text: "" })

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
        isDefault: providers.data?.default[provider.id] === model.id,
      })),
    ),
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
        </span>
      ),
    },
    { id: "provider", header: language.t("operator.column.provider"), value: (model) => model.providerName, cell: (model) => model.providerName },
    {
      id: "context",
      header: language.t("operator.models.context"),
      align: "end",
      value: (model) => model.limit.context,
      cell: (model) => formatCount(model.limit.context, locale()),
    },
    {
      id: "output",
      header: language.t("operator.models.output"),
      align: "end",
      value: (model) => model.limit.output,
      cell: (model) => formatCount(model.limit.output, locale()),
    },
    {
      id: "input",
      header: language.t("operator.models.inputPrice"),
      align: "end",
      value: (model) => model.cost.input,
      cell: (model) => perMillion(model.cost.input),
    },
    {
      id: "outputPrice",
      header: language.t("operator.models.outputPrice"),
      align: "end",
      value: (model) => model.cost.output,
      cell: (model) => perMillion(model.cost.output),
    },
    {
      id: "cache",
      header: language.t("operator.models.cachePrice"),
      align: "end",
      value: (model) => model.cost.cache.read,
      cell: (model) => perMillion(model.cost.cache.read),
    },
    {
      id: "capabilities",
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
        <ColumnPicker columns={columns} hidden={prefs.hidden} onChange={(hidden) => setPrefs("hidden", hidden)} />
      </div>
      <DataTable
        label={language.t("operator.page.models.title")}
        rows={rows()}
        columns={columns}
        hidden={prefs.hidden}
        filter={filter.text}
        search={(model) => `${model.name} ${model.id} ${model.providerName}`}
        loading={providers.isPending}
        empty={language.t("operator.models.empty")}
        initialSort={{ column: "provider", direction: "asc" }}
      />
    </>
  )
}
