import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { McpStatus } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useScopedProject } from "../project"
import { DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"

type Server = { name: string; status: McpStatus }

export default function CapabilitiesPage() {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const directory = useScopedProject()
  const [filter, setFilter] = createStore({ text: "", busy: "" })

  const load = <T,>(name: string, fetch: () => Promise<T>) =>
    useQuery(() => ({ queryKey: api.key(name, directory()), enabled: !!directory(), queryFn: fetch }))
  const tools = load("tools", () =>
    api
      .client()
      .operator.tool.list({ directory: directory() })
      .then((result) => result.data ?? []),
  )
  const skills = load("skills", () =>
    api
      .client()
      .app.skills({ directory: directory() })
      .then((result) => result.data ?? []),
  )
  const commands = load("commands", () =>
    api
      .client()
      .command.list({ directory: directory() })
      .then((result) => result.data ?? []),
  )
  const mcp = load("mcp", () =>
    api
      .client()
      .mcp.status({ directory: directory() })
      .then((result) => result.data ?? {}),
  )
  const servers = createMemo<Server[]>(() =>
    Object.entries(mcp.data ?? {}).map(([name, status]) => ({ name, status })),
  )

  const toggle = async (server: Server) => {
    setFilter("busy", server.name)
    const client = api.client()
    const request =
      server.status.status === "connected"
        ? client.mcp.disconnect({ name: server.name, directory: directory() })
        : client.mcp.connect({ name: server.name, directory: directory() })
    await request
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("mcp", directory()) }))
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("tools", directory()) }))
      .catch((error: unknown) =>
        showToast({
          title: language.t("operator.capabilities.mcpFailed", { name: server.name }),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => setFilter("busy", ""))
  }

  const search = (
    <TextInputV2
      type="search"
      appearance="base"
      value={filter.text}
      onInput={(event) => setFilter("text", event.currentTarget.value)}
      placeholder={language.t("operator.capabilities.search")}
      aria-label={language.t("operator.capabilities.search")}
    />
  )

  return (
    <>
      <PageHeader
        title={language.t("operator.page.capabilities.title")}
        description={language.t("operator.page.capabilities.description")}
        actions={<ScopePicker />}
      />
      <Show
        when={directory()}
        fallback={<EmptyState icon="mcp" title={language.t("operator.project.none")} description={language.t("operator.project.noneHint")} />}
      >
        <TabsV2 defaultValue="tools">
          <TabsV2.List>
            <TabsV2.Trigger value="tools">
              {language.t("operator.capabilities.tools", { count: tools.data?.length ?? 0 })}
            </TabsV2.Trigger>
            <TabsV2.Trigger value="skills">
              {language.t("operator.capabilities.skills", { count: skills.data?.length ?? 0 })}
            </TabsV2.Trigger>
            <TabsV2.Trigger value="commands">
              {language.t("operator.capabilities.commands", { count: commands.data?.length ?? 0 })}
            </TabsV2.Trigger>
            <TabsV2.Trigger value="mcp">
              {language.t("operator.capabilities.mcp", { count: servers().length })}
            </TabsV2.Trigger>
          </TabsV2.List>
          <TabsV2.Content value="tools">
            <div data-slot="operator-toolbar">{search}</div>
            <DataTable
              label={language.t("operator.capabilities.toolsLabel")}
              rows={tools.data ?? []}
              loading={tools.isPending}
              filter={filter.text}
              search={(tool) => `${tool.id} ${tool.description} ${tool.source ?? ""}`}
              initialSort={{ column: "origin", direction: "asc" }}
              columns={[
                { id: "id", header: language.t("operator.column.name"), value: (tool) => tool.id, cell: (tool) => <code>{tool.id}</code> },
                {
                  id: "origin",
                  header: language.t("operator.column.source"),
                  value: (tool) => tool.origin,
                  cell: (tool) => (
                    <span title={tool.source}>
                      <Tag variant={tool.origin === "builtin" ? "neutral" : "accent"}>
                        {language.t(`operator.capabilities.origin.${tool.origin}`)}
                      </Tag>
                      <Show when={tool.origin === "mcp" ? tool.source : undefined}>{(server) => ` ${server()}`}</Show>
                    </span>
                  ),
                },
                {
                  id: "description",
                  header: language.t("operator.column.description"),
                  cell: (tool) => <span data-slot="operator-cell-clamp">{tool.description}</span>,
                },
              ]}
            />
          </TabsV2.Content>
          <TabsV2.Content value="skills">
            <div data-slot="operator-toolbar">{search}</div>
            <DataTable
              label={language.t("operator.capabilities.skillsLabel")}
              rows={skills.data ?? []}
              loading={skills.isPending}
              filter={filter.text}
              search={(skill) => `${skill.name} ${skill.description ?? ""}`}
              empty={language.t("operator.capabilities.noSkills")}
              initialSort={{ column: "name", direction: "asc" }}
              columns={[
                { id: "name", header: language.t("operator.column.name"), value: (skill) => skill.name, cell: (skill) => skill.name },
                {
                  id: "description",
                  header: language.t("operator.column.description"),
                  cell: (skill) => <span data-slot="operator-cell-clamp">{skill.description ?? ""}</span>,
                },
                {
                  id: "location",
                  header: language.t("operator.column.location"),
                  value: (skill) => skill.location,
                  cell: (skill) => <span title={skill.location}>{shortPath(skill.location)}</span>,
                },
              ]}
            />
          </TabsV2.Content>
          <TabsV2.Content value="commands">
            <div data-slot="operator-toolbar">{search}</div>
            <DataTable
              label={language.t("operator.capabilities.commandsLabel")}
              rows={commands.data ?? []}
              loading={commands.isPending}
              filter={filter.text}
              search={(command) => `${command.name} ${command.description ?? ""}`}
              empty={language.t("operator.capabilities.noCommands")}
              initialSort={{ column: "name", direction: "asc" }}
              columns={[
                {
                  id: "name",
                  header: language.t("operator.column.name"),
                  value: (command) => command.name,
                  cell: (command) => <code>/{command.name}</code>,
                },
                {
                  id: "description",
                  header: language.t("operator.column.description"),
                  cell: (command) => <span data-slot="operator-cell-clamp">{command.description ?? ""}</span>,
                },
                {
                  id: "agent",
                  header: language.t("operator.column.agent"),
                  value: (command) => command.agent,
                  cell: (command) => command.agent ?? "",
                },
                {
                  id: "source",
                  header: language.t("operator.column.source"),
                  value: (command) => command.source,
                  cell: (command) => (command.source ? <Tag>{command.source}</Tag> : ""),
                },
              ]}
            />
          </TabsV2.Content>
          <TabsV2.Content value="mcp">
            <DataTable
              label={language.t("operator.capabilities.mcpLabel")}
              rows={servers()}
              loading={mcp.isPending}
              empty={language.t("operator.capabilities.noMcp")}
              initialSort={{ column: "name", direction: "asc" }}
              columns={[
                { id: "name", header: language.t("operator.column.name"), value: (server) => server.name, cell: (server) => server.name },
                {
                  id: "status",
                  header: language.t("operator.column.status"),
                  value: (server) => server.status.status,
                  cell: (server) => (
                    <span title={"error" in server.status ? server.status.error : undefined}>
                      <Tag variant={server.status.status === "connected" ? "accent" : "neutral"}>
                        {language.t(`operator.capabilities.mcpStatus.${server.status.status}`)}
                      </Tag>
                    </span>
                  ),
                },
                {
                  id: "tools",
                  header: language.t("operator.capabilities.toolsLabel"),
                  align: "end",
                  value: (server) => (tools.data ?? []).filter((tool) => tool.source === server.name).length,
                  cell: (server) => (tools.data ?? []).filter((tool) => tool.source === server.name).length,
                },
                {
                  id: "action",
                  header: "",
                  align: "end",
                  cell: (server) => (
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={filter.busy === server.name}
                      onClick={() => void toggle(server)}
                    >
                      {server.status.status === "connected"
                        ? language.t("operator.capabilities.disconnect")
                        : language.t("operator.capabilities.connect")}
                    </ButtonV2>
                  ),
                },
              ]}
            />
          </TabsV2.Content>
        </TabsV2>
      </Show>
    </>
  )
}
