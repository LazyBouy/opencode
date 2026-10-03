import { useNavigate } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { OperatorAgent } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { useOperatorClient } from "../data"
import { formatAgo, formatCount } from "../format"
import { useScopedProject } from "../project"
import { ColumnPicker } from "../ui/column-picker"
import { type Column, DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"

export function useAgents() {
  const api = useOperatorClient()
  const directory = useScopedProject()
  return useQuery(() => ({
    queryKey: api.key("agents", directory()),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.agent.list({ directory: directory() })
        .then((result) => result.data ?? []),
  }))
}

export function agentModel(agent: OperatorAgent) {
  return agent.model ? `${agent.model.providerID}/${agent.model.modelID}` : ""
}

export default function AgentsPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const directory = useScopedProject()
  const agents = useAgents()
  const [store, setStore] = persisted(
    Persist.global("operator.agents"),
    createStore({ hidden: [] as string[], showHidden: false }),
  )
  const [filter, setFilter] = createStore({ text: "" })

  const rows = createMemo(() => (agents.data ?? []).filter((agent) => store.showHidden || !agent.hidden))
  const sourceLabel = (agent: OperatorAgent) => language.t(`operator.agents.source.${agent.source.kind}`)

  const columns: Column<OperatorAgent>[] = [
    {
      id: "name",
      header: language.t("operator.column.name"),
      value: (agent) => agent.name,
      cell: (agent) => (
        <span class="flex items-center gap-2">
          <span data-slot="operator-color-dot" style={{ background: agent.color ?? "var(--v2-icon-icon-muted)" }} />
          {agent.name}
          <Show when={agent.hidden}>
            <Tag>{language.t("operator.agents.hidden")}</Tag>
          </Show>
          <Show when={agent.disabled}>
            <Tag>{language.t("operator.agent.off")}</Tag>
          </Show>
        </span>
      ),
    },
    {
      id: "mode",
      header: language.t("operator.column.mode"),
      value: (agent) => agent.mode,
      cell: (agent) => language.t(`operator.agents.mode.${agent.mode}`),
    },
    {
      id: "model",
      header: language.t("operator.column.model"),
      value: agentModel,
      cell: (agent) => agentModel(agent) || language.t("operator.agents.defaultModel"),
    },
    {
      id: "source",
      header: language.t("operator.column.source"),
      value: sourceLabel,
      cell: (agent) => (
        <span title={agent.source.path}>
          <Tag variant={agent.source.kind === "builtin" ? "neutral" : "accent"}>{sourceLabel(agent)}</Tag>
          <Show when={agent.source.customized}>
            {" "}
            <Tag>{language.t("operator.agents.customized")}</Tag>
          </Show>
        </span>
      ),
    },
    {
      id: "description",
      header: language.t("operator.column.description"),
      cell: (agent) => <span data-slot="operator-cell-clamp">{agent.description ?? ""}</span>,
    },
    {
      id: "sessions",
      header: language.t("operator.column.sessions"),
      align: "end",
      value: (agent) => agent.sessions.total,
      cell: (agent) => formatCount(agent.sessions.total, language.intl()),
    },
    {
      id: "lastUsed",
      header: language.t("operator.column.lastUsed"),
      align: "end",
      value: (agent) => agent.sessions.lastUsed,
      cell: (agent) => formatAgo(agent.sessions.lastUsed, language.intl()),
    },
  ]

  return (
    <>
      <PageHeader
        title={language.t("operator.page.agents.title")}
        description={language.t("operator.page.agents.description")}
        actions={
          <>
            <ScopePicker />
            <Show when={directory()}>
              <ButtonV2
                size="small"
                variant="contrast"
                onClick={() => navigate(`/operator/agents/new?dir=${encodeURIComponent(directory() ?? "")}`)}
              >
                {language.t("operator.agents.new")}
              </ButtonV2>
            </Show>
          </>
        }
      />
      <Show
        when={directory()}
        fallback={
          <EmptyState
            icon="brain"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        <div data-slot="operator-toolbar">
          <TextInputV2
            type="search"
            appearance="base"
            value={filter.text}
            onInput={(event) => setFilter("text", event.currentTarget.value)}
            placeholder={language.t("operator.agents.search")}
            aria-label={language.t("operator.agents.search")}
          />
          <Switch checked={store.showHidden} onChange={(checked) => setStore("showHidden", checked)}>
            {language.t("operator.agents.showHidden")}
          </Switch>
          <ColumnPicker columns={columns} hidden={store.hidden} onChange={(hidden) => setStore("hidden", hidden)} />
        </div>
        <DataTable
          label={language.t("operator.page.agents.title")}
          rows={rows()}
          columns={columns}
          hidden={store.hidden}
          filter={filter.text}
          search={(agent) => `${agent.name} ${agent.description ?? ""} ${agentModel(agent)}`}
          loading={agents.isPending}
          initialSort={{ column: "name", direction: "asc" }}
          onRowClick={(agent) =>
            navigate(`/operator/agents/${encodeURIComponent(agent.name)}?dir=${encodeURIComponent(directory() ?? "")}`)
          }
        />
      </Show>
    </>
  )
}
