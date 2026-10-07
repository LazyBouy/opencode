import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { McpStatus } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useSearchParams } from "@solidjs/router"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useScopedProject } from "../project"
import { DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { useTrashItem } from "./trash"
import { ScopePicker } from "../ui/scope-picker"
import { useOverlayParams } from "../ui/overlay-nav"

// Where OpenCode's own skills say they live, and OpenCode's own commands (`Default` in
// command/index.ts; `merge` is the fork's).
const BUILTIN_SKILL = "<built-in>"
const BUILTIN_COMMANDS = ["init", "review", "merge"]

type Server = { name: string; status: McpStatus }

type Kind = "tools" | "skills" | "commands" | "mcp"
type Params = { kind?: string; item?: string; tab?: string }

// A project's tools, skills, commands and MCP servers.
function useCapabilities() {
  const api = useOperatorClient()
  const directory = useScopedProject()
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
  const servers = createMemo<Server[]>(() => Object.entries(mcp.data ?? {}).map(([name, status]) => ({ name, status })))
  return { directory, tools, skills, commands, mcp, servers }
}

// Connects or disconnects an MCP server of the project.
function useMcpToggle(directory: () => string | undefined) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const [state, setState] = createStore({ busy: "" })
  const toggle = async (server: Server) => {
    setState("busy", server.name)
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
      .finally(() => setState("busy", ""))
  }
  return { toggle, busy: () => state.busy }
}

export default function CapabilitiesPage() {
  const language = useLanguage()
  const { directory, tools, skills, commands, mcp, servers } = useCapabilities()
  const mcpToggle = useMcpToggle(directory)
  const [filter, setFilter] = createStore({ text: "" })
  // A row opens in the overlay: `kind` (tools, skills, commands, mcp) and `item`. `tab` is the list shown.
  const [params, setParams] = useSearchParams<Params>()
  useRecordOverlay(
    () => !!params.item,
    () => <CapabilityOverlay />,
    ["kind", "item"],
  )
  const open = (kind: Kind, item: string) => setParams({ kind, item })

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
        fallback={
          <EmptyState
            icon="mcp"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        <TabsV2 value={params.tab ?? "tools"} onChange={(value: string) => setParams({ tab: value })}>
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
              columnsKey="tools"
              label={language.t("operator.capabilities.toolsLabel")}
              rows={tools.data ?? []}
              loading={tools.isPending}
              filter={filter.text}
              search={(tool) => `${tool.id} ${tool.description} ${tool.source ?? ""}`}
              initialSort={{ column: "origin", direction: "asc" }}
              onRowClick={(tool) => open("tools", tool.id)}
              columns={[
                {
                  id: "id",
                  header: language.t("operator.column.name"),
                  value: (tool) => tool.id,
                  cell: (tool) => <code>{tool.id}</code>,
                },
                {
                  id: "origin",
                  optional: true,
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
                  optional: true,
                  header: language.t("operator.column.description"),
                  cell: (tool) => <span data-slot="operator-cell-clamp">{tool.description}</span>,
                },
              ]}
            />
          </TabsV2.Content>
          <TabsV2.Content value="skills">
            <div data-slot="operator-toolbar">{search}</div>
            <DataTable
              columnsKey="skills"
              label={language.t("operator.capabilities.skillsLabel")}
              rows={skills.data ?? []}
              loading={skills.isPending}
              filter={filter.text}
              search={(skill) => `${skill.name} ${skill.description ?? ""}`}
              empty={language.t("operator.capabilities.noSkills")}
              initialSort={{ column: "name", direction: "asc" }}
              onRowClick={(skill) => open("skills", skill.name)}
              columns={[
                {
                  id: "name",
                  header: language.t("operator.column.name"),
                  value: (skill) => skill.name,
                  cell: (skill) => skill.name,
                },
                {
                  id: "description",
                  optional: true,
                  header: language.t("operator.column.description"),
                  cell: (skill) => <span data-slot="operator-cell-clamp">{skill.description ?? ""}</span>,
                },
                {
                  id: "location",
                  optional: true,
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
              columnsKey="commands"
              label={language.t("operator.capabilities.commandsLabel")}
              rows={commands.data ?? []}
              loading={commands.isPending}
              filter={filter.text}
              search={(command) => `${command.name} ${command.description ?? ""}`}
              empty={language.t("operator.capabilities.noCommands")}
              initialSort={{ column: "name", direction: "asc" }}
              onRowClick={(command) => open("commands", command.name)}
              columns={[
                {
                  id: "name",
                  header: language.t("operator.column.name"),
                  value: (command) => command.name,
                  cell: (command) => <code>/{command.name}</code>,
                },
                {
                  id: "description",
                  optional: true,
                  header: language.t("operator.column.description"),
                  cell: (command) => <span data-slot="operator-cell-clamp">{command.description ?? ""}</span>,
                },
                {
                  id: "agent",
                  optional: true,
                  header: language.t("operator.column.agent"),
                  value: (command) => command.agent,
                  cell: (command) => command.agent ?? "",
                },
                {
                  id: "source",
                  optional: true,
                  header: language.t("operator.column.source"),
                  value: (command) => command.source,
                  cell: (command) => (command.source ? <Tag>{command.source}</Tag> : ""),
                },
              ]}
            />
          </TabsV2.Content>
          <TabsV2.Content value="mcp">
            <DataTable
              columnsKey="mcp"
              label={language.t("operator.capabilities.mcpLabel")}
              rows={servers()}
              loading={mcp.isPending}
              empty={language.t("operator.capabilities.noMcp")}
              initialSort={{ column: "name", direction: "asc" }}
              onRowClick={(server) => open("mcp", server.name)}
              columns={[
                {
                  id: "name",
                  header: language.t("operator.column.name"),
                  value: (server) => server.name,
                  cell: (server) => server.name,
                },
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
                  optional: true,
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
                      disabled={mcpToggle.busy() === server.name}
                      onClick={(event: MouseEvent) => {
                        event.stopPropagation()
                        void mcpToggle.toggle(server)
                      }}
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

// The overlay a tool, skill, command or MCP server opens in: the four lists on the left.
function CapabilityOverlay() {
  const language = useLanguage()
  const { directory, tools, skills, commands, servers } = useCapabilities()
  const mcpToggle = useMcpToggle(directory)
  const [params, setParams] = useOverlayParams<Params>()
  const trash = useTrashItem(directory)
  const gone = () => setParams({ item: undefined })
  const deleteButton = (kind: "skill" | "command" | "tool" | "mcp", name: string, label = name) => (
    <ButtonV2 variant="danger" onClick={() => void trash(kind, name, label, gone)}>
      {language.t("operator.trash.delete")}
    </ButtonV2>
  )
  const kind = (): Kind =>
    ["tools", "skills", "commands", "mcp"].includes(params.kind ?? "") ? (params.kind as Kind) : "tools"
  const blocks = createMemo<OverlayBlock[]>(() => [
    {
      id: "tools",
      label: language.t("operator.capabilities.toolsLabel"),
      icon: "console",
      records: (tools.data ?? []).map((tool) => ({ id: tool.id, label: tool.id, detail: tool.origin })),
    },
    {
      id: "skills",
      label: language.t("operator.capabilities.skillsLabel"),
      icon: "brain",
      empty: language.t("operator.capabilities.noSkills"),
      records: (skills.data ?? []).map((skill) => ({ id: skill.name, label: skill.name })),
    },
    {
      id: "commands",
      label: language.t("operator.capabilities.commandsLabel"),
      icon: "code",
      empty: language.t("operator.capabilities.noCommands"),
      records: (commands.data ?? []).map((command) => ({ id: command.name, label: `/${command.name}` })),
    },
    {
      id: "mcp",
      label: language.t("operator.capabilities.mcpLabel"),
      icon: "mcp",
      empty: language.t("operator.capabilities.noMcp"),
      records: servers().map((server) => ({ id: server.name, label: server.name })),
    },
  ])
  const tool = () => (kind() === "tools" ? tools.data?.find((item) => item.id === params.item) : undefined)
  const skill = () => (kind() === "skills" ? skills.data?.find((item) => item.name === params.item) : undefined)
  const command = () => (kind() === "commands" ? commands.data?.find((item) => item.name === params.item) : undefined)
  const server = () => (kind() === "mcp" ? servers().find((item) => item.name === params.item) : undefined)

  return (
    <RecordOverlay
      title={language.t("operator.page.capabilities.title")}
      namespaces={[]}
      blocks={blocks()}
      block={kind()}
      record={params.item}
      editing={false}
      onBlock={(id) => setParams({ kind: id, item: undefined, tab: id })}
      onRecord={(block, id) => setParams({ kind: block, item: id })}
    >
      <Show when={tool()}>
        {(found) => (
          <RecordView
            title={<code>{found().id}</code>}
            builtin={found().origin === "builtin"}
            actions={
              found().origin !== "builtin" && found().origin !== "mcp" ? deleteButton("tool", found().id) : undefined
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.column.source")} help={language.t("operator.help.toolSource")}>
                {language.t(`operator.capabilities.origin.${found().origin}`)}
                <Show when={found().source}>{(source) => ` · ${source()}`}</Show>
              </RecordField>
              <RecordField
                label={language.t("operator.column.description")}
                help={language.t("operator.help.toolDescription")}
              >
                <pre data-component="operator-code">{found().description}</pre>
              </RecordField>
            </dl>
          </RecordView>
        )}
      </Show>
      <Show when={skill()}>
        {(found) => (
          <RecordView
            title={found().name}
            builtin={found().location === BUILTIN_SKILL}
            actions={found().location === BUILTIN_SKILL ? undefined : deleteButton("skill", found().name)}
          >
            <dl data-component="record-fields">
              <RecordField
                label={language.t("operator.column.description")}
                help={language.t("operator.help.skillDescription")}
              >
                {found().description ?? "—"}
              </RecordField>
              <RecordField
                label={language.t("operator.column.location")}
                help={language.t("operator.help.skillLocation")}
              >
                {found().location}
              </RecordField>
            </dl>
          </RecordView>
        )}
      </Show>
      <Show when={command()}>
        {(found) => (
          <RecordView
            title={<code>/{found().name}</code>}
            builtin={BUILTIN_COMMANDS.includes(found().name)}
            actions={
              found().source === "command" && !BUILTIN_COMMANDS.includes(found().name)
                ? deleteButton("command", found().name, `/${found().name}`)
                : undefined
            }
          >
            <dl data-component="record-fields">
              <RecordField
                label={language.t("operator.column.description")}
                help={language.t("operator.help.commandDescription")}
              >
                {found().description ?? "—"}
              </RecordField>
              <RecordField label={language.t("operator.column.agent")} help={language.t("operator.help.commandAgent")}>
                {found().agent ?? "—"}
              </RecordField>
              <RecordField
                label={language.t("operator.column.source")}
                help={language.t("operator.help.commandSource")}
              >
                {found().source ?? "—"}
              </RecordField>
              <Show when={found().template}>
                {(template) => (
                  <RecordField
                    label={language.t("operator.capabilities.template")}
                    help={language.t("operator.help.commandTemplate")}
                  >
                    <pre data-component="operator-code">{String(template())}</pre>
                  </RecordField>
                )}
              </Show>
            </dl>
          </RecordView>
        )}
      </Show>
      <Show when={server()}>
        {(found) => (
          <RecordView
            title={found().name}
            actions={
              <>
                <ButtonV2
                  variant="outline"
                  disabled={mcpToggle.busy() === found().name}
                  onClick={() => void mcpToggle.toggle(found())}
                >
                  {found().status.status === "connected"
                    ? language.t("operator.capabilities.disconnect")
                    : language.t("operator.capabilities.connect")}
                </ButtonV2>
                {deleteButton("mcp", found().name)}
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField label={language.t("operator.column.status")} help={language.t("operator.help.mcpStatus")}>
                {language.t(`operator.capabilities.mcpStatus.${found().status.status}`)}
                <Show when={"error" in found().status ? (found().status as { error: string }).error : undefined}>
                  {(error) => ` · ${error()}`}
                </Show>
              </RecordField>
              <RecordField
                label={language.t("operator.capabilities.toolsLabel")}
                help={language.t("operator.help.mcpTools")}
              >
                <Show when={(tools.data ?? []).filter((tool) => tool.source === found().name).length} fallback="—">
                  <ul>
                    <For each={(tools.data ?? []).filter((tool) => tool.source === found().name)}>
                      {(tool) => (
                        <li>
                          <code>{tool.id}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </RecordField>
            </dl>
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}
