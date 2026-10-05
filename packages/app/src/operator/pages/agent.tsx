import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, type JSX, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOpenSession, useOperatorClient } from "../data"
import { formatAgo, formatCost } from "../format"
import { useScopedProject } from "../project"
import { useConfirm } from "../ui/confirm"
import { DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { AgentPrompt, useAgentPromptSetting } from "./agent-prompt"
import { agentModel, useAgents } from "./agents"
import { requestError } from "./config-helpers"
import { FieldHelp } from "../ui/field-help"

export default function AgentPage() {
  const language = useLanguage()
  const params = useParams<{ name: string }>()
  // The open tab is kept in the URL, so links can open the Prompt tab directly.
  const [search, setSearch] = useSearchParams<{ tab?: string }>()
  const tab = () =>
    ["overview", "prompt", "permissions", "sessions"].includes(search.tab ?? "") ? search.tab! : "overview"
  const api = useOperatorClient()
  const openSession = useOpenSession()
  const directory = useScopedProject()
  const agents = useAgents()
  const agent = createMemo(() => agents.data?.find((item) => item.name === decodeURIComponent(params.name)))
  const prompt = useAgentPromptSetting(() => decodeURIComponent(params.name), directory)
  const sessions = useQuery(() => ({
    queryKey: api.key("sessions", "agent", directory(), params.name),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.session.list({ directory: directory(), agent: decodeURIComponent(params.name), limit: "100" })
        .then((result) => result.data ?? []),
  }))
  const locale = () => language.intl()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const dir = () => `?dir=${encodeURIComponent(directory() ?? "")}`
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key("agents", directory()) })
  const fail = (error: unknown) =>
    showToast({ title: language.t("operator.agent.actionFailed"), description: requestError(error) })

  // A new session as this agent, in its home folder when it has one.
  const start = async (name: string, home: string | undefined) => {
    await api
      .client()
      .session.create({ directory: home ?? directory(), agent: name })
      .then((result) => openSession(result.data!.id))
      .catch(fail)
  }
  const toggle = async (name: string, disabled: boolean) => {
    await api
      .client()
      .operator.agent.update({
        name,
        directory: directory(),
        scope: "project",
        ...(disabled ? { reset: ["disable" as const] } : { disable: true }),
      })
      .then(refresh)
      .catch(fail)
  }
  const remove = async (name: string) => {
    const ok = await confirm({
      title: language.t("operator.agent.deleteTitle", { name }),
      description: language.t("operator.agent.deleteBody"),
      confirm: language.t("operator.agent.delete"),
      danger: true,
    })
    if (!ok) return
    await api
      .client()
      .operator.agent.remove({ name, directory: directory(), scope: "project" })
      .then(async () => {
        await refresh()
        navigate(`/operator/agents${dir()}`)
      })
      .catch(fail)
  }

  return (
    <Show
      when={agent()}
      fallback={
        <EmptyState
          icon="brain"
          title={agents.isPending ? language.t("common.loading") : language.t("operator.agent.notFound")}
        />
      }
    >
      {(current) => (
        <>
          <PageHeader
            title={current().name}
            description={current().description}
            actions={
              <span class="flex items-center gap-2 flex-wrap">
                <Tag>{language.t(`operator.agents.mode.${current().mode}`)}</Tag>
                <Tag variant={current().source.kind === "builtin" ? "neutral" : "accent"}>
                  {language.t(`operator.agents.source.${current().source.kind}`)}
                </Tag>
                <Show when={current().disabled}>
                  <Tag>{language.t("operator.agent.off")}</Tag>
                </Show>
                <Show when={!current().disabled && current().mode !== "subagent"}>
                  <ButtonV2 size="small" variant="contrast" onClick={() => void start(current().name, current().home)}>
                    {language.t("operator.agent.start")}
                  </ButtonV2>
                </Show>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() => navigate(`/operator/agents/${encodeURIComponent(current().name)}/edit${dir()}`)}
                >
                  {language.t("operator.agent.edit")}
                </ButtonV2>
                <ButtonV2
                  size="small"
                  variant="outline"
                  onClick={() => void toggle(current().name, current().disabled)}
                >
                  {current().disabled ? language.t("operator.agent.turnOn") : language.t("operator.agent.turnOff")}
                </ButtonV2>
                <Show when={current().source.kind !== "builtin"}>
                  <ButtonV2 size="small" variant="danger" onClick={() => void remove(current().name)}>
                    {language.t("operator.agent.delete")}
                  </ButtonV2>
                </Show>
              </span>
            }
          />
          <TabsV2 value={tab()} onChange={(value: string) => setSearch({ tab: value })}>
            <TabsV2.List>
              <TabsV2.Trigger value="overview">{language.t("operator.agent.tab.overview")}</TabsV2.Trigger>
              <TabsV2.Trigger value="prompt">{language.t("operator.agent.tab.prompt")}</TabsV2.Trigger>
              <TabsV2.Trigger value="permissions">{language.t("operator.agent.tab.permissions")}</TabsV2.Trigger>
              <TabsV2.Trigger value="sessions">{language.t("operator.agent.tab.sessions")}</TabsV2.Trigger>
            </TabsV2.List>
            <TabsV2.Content value="overview">
              <dl data-component="operator-facts">
                <Fact label={language.t("operator.column.model")} help={language.t("operator.help.agentModelFact")}>
                  {agentModel(current()) || language.t("operator.agents.defaultModel")}
                </Fact>
                <Fact label={language.t("operator.prompts.profile")} help={language.t("operator.help.agentProfile")}>
                  <Show when={prompt.data} fallback="—">
                    {(found) =>
                      language.t("operator.prompts.profileFrom", {
                        name: found().profile.name,
                        source: language.t(`operator.prompts.source.${found().profile.source}`),
                      })
                    }
                  </Show>
                </Fact>
                <Fact label={language.t("operator.agent.variant")} help={language.t("operator.help.variant")}>
                  {current().variant ?? "—"}
                </Fact>
                <Fact label={language.t("operator.agent.temperature")} help={language.t("operator.help.temperature")}>
                  {current().temperature ?? "—"}
                </Fact>
                <Fact label={language.t("operator.agent.topP")} help={language.t("operator.help.topP")}>
                  {current().topP ?? "—"}
                </Fact>
                <Fact label={language.t("operator.agent.steps")} help={language.t("operator.help.steps")}>
                  {current().steps ?? "—"}
                </Fact>
                <Fact label={language.t("operator.column.source")} help={language.t("operator.help.agentSource")}>
                  {current().source.path ?? language.t(`operator.agents.source.${current().source.kind}`)}
                </Fact>
                <Fact label={language.t("operator.agentForm.home")} help={language.t("operator.agentForm.homeHint")}>
                  {current().home ?? "—"}
                </Fact>
                <Fact label={language.t("operator.column.sessions")} help={language.t("operator.help.agentSessions")}>
                  {current().sessions.total}
                </Fact>
                <Fact label={language.t("operator.column.lastUsed")} help={language.t("operator.help.agentLastUsed")}>
                  {formatAgo(current().sessions.lastUsed, locale()) || "—"}
                </Fact>
              </dl>
            </TabsV2.Content>
            <TabsV2.Content value="prompt">
              <Show when={directory()}>{(dir) => <AgentPrompt agent={current().name} directory={dir()} />}</Show>
            </TabsV2.Content>
            <TabsV2.Content value="permissions">
              <p data-slot="operator-note">{language.t("operator.agent.rulesHint")}</p>
              <DataTable
                columnsKey="agent-permissions"
                label={language.t("operator.agent.tab.permissions")}
                rows={current().permission.map((rule, index) => ({ ...rule, index: index + 1 }))}
                empty={language.t("operator.agent.noRules")}
                columns={[
                  { id: "index", header: "#", width: "48px", cell: (rule) => rule.index, value: (rule) => rule.index },
                  {
                    id: "permission",
                    header: language.t("operator.column.permission"),
                    cell: (rule) => <code>{rule.permission}</code>,
                    value: (rule) => rule.permission,
                  },
                  {
                    id: "pattern",
                    header: language.t("operator.column.pattern"),
                    cell: (rule) => <code>{rule.pattern}</code>,
                    value: (rule) => rule.pattern,
                  },
                  {
                    id: "action",
                    header: language.t("operator.column.action"),
                    cell: (rule) => (
                      <Tag variant={rule.action === "allow" ? "accent" : "neutral"}>
                        {language.t(`operator.permission.action.${rule.action}`)}
                      </Tag>
                    ),
                    value: (rule) => rule.action,
                  },
                ]}
              />
            </TabsV2.Content>
            <TabsV2.Content value="sessions">
              <DataTable
                columnsKey="agent-sessions"
                label={language.t("operator.agent.tab.sessions")}
                rows={sessions.data ?? []}
                loading={sessions.isPending}
                empty={language.t("operator.agent.noSessions")}
                onRowClick={(session) => openSession(session.id)}
                columns={[
                  { id: "title", header: language.t("operator.column.title"), cell: (session) => session.title },
                  {
                    id: "cost",
                    optional: true,
                    header: language.t("operator.column.cost"),
                    align: "end",
                    cell: (session) => formatCost(session.cost ?? 0, locale()),
                    value: (session) => session.cost ?? 0,
                  },
                  {
                    id: "updated",
                    optional: true,
                    header: language.t("operator.column.updated"),
                    align: "end",
                    cell: (session) => formatAgo(session.time.updated, locale()),
                    value: (session) => session.time.updated,
                  },
                ]}
              />
            </TabsV2.Content>
          </TabsV2>
        </>
      )}
    </Show>
  )
}

// A fact about the agent, with the field helper's (i) explaining it.
function Fact(props: { label: string; help: string; children: JSX.Element }) {
  return (
    <>
      <dt>
        {props.label}
        <FieldHelp field={props.label} text={props.help} />
      </dt>
      <dd>{props.children}</dd>
    </>
  )
}
