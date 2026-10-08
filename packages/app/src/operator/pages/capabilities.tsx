import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type { McpStatus, OperatorCapability, OperatorCapabilityKind } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useSearchParams } from "@solidjs/router"
import { createMemo, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { shortPath } from "../format"
import { useScopedProject } from "../project"
import { type Column, DataTable } from "../ui/data-table"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { type OverlayBlock, RecordField, RecordOverlay, RecordView, useRecordOverlay } from "../ui/record-overlay"
import { ScopePicker } from "../ui/scope-picker"
import { useOverlayParams } from "../ui/overlay-nav"
import { SkillsNote } from "./skills-note"
import {
  CapabilityActions,
  CapabilityScopePicker,
  itemOf,
  OriginChip,
  stateText,
  useCapabilityScope,
  useCreateCapability,
  useInventory,
} from "./capability-scope"

// Capabilities (capability_scopes_spec.md §9): a project's effective tools, skills, commands, MCP
// servers, agents and plugins, or a namespace's own layer (the scope picker). Every row shows where
// its definition comes from and its state; a record has the scope's actions (override, disable,
// revert, delete) and each list has New.

type Kind = "tools" | "skills" | "commands" | "mcp" | "agents" | "plugins"
type Params = { kind?: string; item?: string; tab?: string }
type Server = { name: string; status: McpStatus }
type Row = { name: string; item?: OperatorCapability; description?: string; detail?: string }

const KINDS: Kind[] = ["tools", "skills", "commands", "mcp", "agents", "plugins"]
const KIND: Record<Kind, OperatorCapabilityKind> = {
  tools: "tool",
  skills: "skill",
  commands: "command",
  mcp: "mcp",
  agents: "agent",
  plugins: "plugin",
}

// The capabilities in view: the inventory, joined in the project view with what OpenCode reports live
// (descriptions, templates, MCP status, the tools MCP servers and plugins add).
function useCapabilities() {
  const api = useOperatorClient()
  const directory = useScopedProject()
  const scope = useCapabilityScope()
  const namespace = () => (scope.view() === "namespace" ? scope.namespace() : undefined)
  const inventory = useInventory(directory, namespace)
  const live = () => !!directory() && scope.view() === "project"
  const load = <T,>(name: string, fetch: () => Promise<T>) =>
    useQuery(() => ({ queryKey: api.key(name, directory()), enabled: live(), queryFn: fetch }))
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
  const items = () => inventory.data?.items ?? []
  // Rows: the live ones (project view), then inventory items they don't list (a turned-off command, a
  // namespace's own item in the namespace view).
  const rows = (kind: Kind): Row[] => {
    const own = items().filter((item) => item.kind === KIND[kind])
    const listed: Row[] = !live()
      ? []
      : kind === "tools"
        ? (tools.data ?? []).map((tool) => ({
            name: tool.id,
            item: itemOf(own, "tool", tool.id),
            description: tool.description,
            detail: tool.origin,
          }))
        : kind === "skills"
          ? (skills.data ?? []).map((skill) => ({
              name: skill.name,
              item: itemOf(own, "skill", skill.name),
              description: skill.description,
              detail: skill.location,
            }))
          : kind === "commands"
            ? (commands.data ?? []).map((command) => ({
                name: command.name,
                // A skill also runs as a command: it shows the skill's scope.
                item:
                  itemOf(own, "command", command.name) ??
                  (command.source === "skill" ? itemOf(items(), "skill", command.name) : undefined),
                description: command.description,
                detail: command.source,
              }))
            : kind === "mcp"
              ? servers().map((server) => ({ name: server.name, item: itemOf(own, "mcp", server.name) }))
              : []
    const names = new Set(listed.map((row) => row.name))
    return [
      ...listed,
      ...own
        .filter((item) => !names.has(item.name))
        .map((item) => ({ name: item.name, item, description: item.description })),
    ]
  }
  return { directory, scope, namespace, inventory, tools, skills, commands, mcp, servers, rows, live }
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
  return { toggle, busy: () => (state.busy === "" ? undefined : state.busy) }
}

export default function CapabilitiesPage() {
  const language = useLanguage()
  const data = useCapabilities()
  const mcpToggle = useMcpToggle(data.directory)
  const create = useCreateCapability(data.directory, data.namespace)
  const [filter, setFilter] = createStore({ text: "" })
  // A row opens in the overlay: `kind` (tools, skills, …) and `item`. `tab` is the list shown.
  const [params, setParams] = useSearchParams<Params>()
  useRecordOverlay(
    () => !!params.item,
    () => <CapabilityOverlay />,
    ["kind", "item"],
  )
  const open = (kind: Kind, item: string) => setParams({ kind, item })
  const tab = (): Kind => (KINDS.includes(params.tab as Kind) ? (params.tab as Kind) : "tools")

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
  const toolbar = (kind: Kind) => (
    <div data-slot="operator-toolbar">
      {search}
      <ButtonV2 size="small" variant="outline" onClick={() => create(KIND[kind])}>
        {language.t(`operator.capabilities.new.${KIND[kind]}`)}
      </ButtonV2>
    </div>
  )

  // Columns every list has: name, where it comes from, its state, its description.
  const common = (kind: Kind, extra: Column<Row>[] = []): Column<Row>[] => [
    {
      id: "name",
      header: language.t("operator.column.name"),
      value: (row) => row.name,
      cell: (row) =>
        kind === "commands" ? <code>/{row.name}</code> : kind === "tools" ? <code>{row.name}</code> : row.name,
    },
    {
      id: "scope",
      optional: true,
      header: language.t("operator.capabilities.scope"),
      value: (row) => row.item?.origin ?? "",
      cell: (row) => <OriginChip origin={row.item?.origin} />,
    },
    {
      id: "state",
      optional: true,
      header: language.t("operator.capabilities.stateLabel"),
      value: (row) => row.item?.state ?? "",
      cell: (row) => (
        <span data-slot="operator-cell-clamp" data-state={row.item?.state}>
          {stateText(language, row.item)}
        </span>
      ),
    },
    ...extra,
    {
      id: "description",
      optional: true,
      header: language.t("operator.column.description"),
      cell: (row) => <span data-slot="operator-cell-clamp">{row.description ?? ""}</span>,
    },
  ]

  const table = (kind: Kind, columns: Column<Row>[], empty?: string): JSX.Element => (
    <DataTable
      columnsKey={kind}
      label={language.t(`operator.capabilities.${kind}Label`)}
      rows={data.rows(kind)}
      loading={data.inventory.isPending}
      filter={filter.text}
      search={(row) => `${row.name} ${row.description ?? ""}`}
      empty={empty}
      initialSort={{ column: "name", direction: "asc" }}
      onRowClick={(row) => open(kind, row.name)}
      columns={columns}
    />
  )

  return (
    <>
      <PageHeader
        title={language.t("operator.page.capabilities.title")}
        description={language.t("operator.page.capabilities.description")}
        actions={
          <span class="inline-flex items-center gap-2 flex-wrap">
            <CapabilityScopePicker />
            <Show when={data.scope.view() === "project"}>
              <ScopePicker />
            </Show>
          </span>
        }
      />
      <Show
        when={data.directory()}
        fallback={
          <EmptyState
            icon="mcp"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        <Show when={data.scope.view() === "namespace" && data.inventory.data}>
          {(found) => (
            <p data-slot="operator-note" data-testid="capability-scope-note">
              {language.t(
                found().inheritGlobal
                  ? "operator.capabilities.namespaceNote"
                  : "operator.capabilities.namespaceNoteOff",
                {
                  name: data.scope.namespaces.name(found().namespace),
                },
              )}
            </p>
          )}
        </Show>
        <TabsV2 value={tab()} onChange={(value: string) => setParams({ tab: value })}>
          <TabsV2.List>
            <For each={KINDS}>
              {(kind) => (
                <TabsV2.Trigger value={kind}>
                  {language.t(`operator.capabilities.${kind}`, { count: data.rows(kind).length })}
                </TabsV2.Trigger>
              )}
            </For>
          </TabsV2.List>
          <TabsV2.Content value="tools">
            {toolbar("tools")}
            {table(
              "tools",
              common("tools", [
                {
                  id: "origin",
                  optional: true,
                  header: language.t("operator.column.source"),
                  value: (row) => row.detail ?? "",
                  cell: (row) => (
                    <Show when={row.detail}>
                      {(origin) => (
                        <Tag variant={origin() === "builtin" ? "neutral" : "accent"}>
                          {language.t(`operator.capabilities.origin.${origin() as "builtin"}`)}
                        </Tag>
                      )}
                    </Show>
                  ),
                },
              ]),
            )}
          </TabsV2.Content>
          <TabsV2.Content value="skills">
            <SkillsNote directory={data.directory()!} />
            {toolbar("skills")}
            {table(
              "skills",
              common("skills", [
                {
                  id: "location",
                  optional: true,
                  header: language.t("operator.column.location"),
                  value: (row) => row.item?.location ?? row.detail ?? "",
                  cell: (row) => (
                    <span title={row.item?.location ?? row.detail}>
                      {shortPath(row.item?.location ?? row.detail ?? "")}
                    </span>
                  ),
                },
              ]),
              language.t("operator.capabilities.noSkills"),
            )}
          </TabsV2.Content>
          <TabsV2.Content value="commands">
            {toolbar("commands")}
            {table("commands", common("commands"), language.t("operator.capabilities.noCommands"))}
          </TabsV2.Content>
          <TabsV2.Content value="mcp">
            {toolbar("mcp")}
            {table(
              "mcp",
              common("mcp", [
                {
                  id: "status",
                  header: language.t("operator.column.status"),
                  value: (row) => data.servers().find((server) => server.name === row.name)?.status.status ?? "",
                  cell: (row) => (
                    <Show when={data.servers().find((server) => server.name === row.name)}>
                      {(server) => (
                        <span
                          title={"error" in server().status ? (server().status as { error: string }).error : undefined}
                        >
                          <Tag variant={server().status.status === "connected" ? "accent" : "neutral"}>
                            {language.t(`operator.capabilities.mcpStatus.${server().status.status}`)}
                          </Tag>
                        </span>
                      )}
                    </Show>
                  ),
                },
                {
                  id: "action",
                  header: "",
                  align: "end",
                  cell: (row) => (
                    <Show when={data.servers().find((server) => server.name === row.name)}>
                      {(server) => (
                        <ButtonV2
                          size="small"
                          variant="outline"
                          disabled={mcpToggle.busy() === server().name}
                          onClick={(event: MouseEvent) => {
                            event.stopPropagation()
                            void mcpToggle.toggle(server())
                          }}
                        >
                          {server().status.status === "connected"
                            ? language.t("operator.capabilities.disconnect")
                            : language.t("operator.capabilities.connect")}
                        </ButtonV2>
                      )}
                    </Show>
                  ),
                },
              ]),
              language.t("operator.capabilities.noMcp"),
            )}
          </TabsV2.Content>
          <TabsV2.Content value="agents">
            {toolbar("agents")}
            {table("agents", common("agents"), language.t("operator.capabilities.noAgents"))}
          </TabsV2.Content>
          <TabsV2.Content value="plugins">
            {toolbar("plugins")}
            {table("plugins", common("plugins"), language.t("operator.capabilities.noPlugins"))}
          </TabsV2.Content>
        </TabsV2>
      </Show>
    </>
  )
}

// The overlay a capability opens in: the six lists on the left; the record with where it comes from,
// its state, what it replaces, and the scope's actions.
function CapabilityOverlay() {
  const language = useLanguage()
  const data = useCapabilities()
  const mcpToggle = useMcpToggle(data.directory)
  const [params, setParams] = useOverlayParams<Params>()
  const gone = () => setParams({ item: undefined })
  const kind = (): Kind => (KINDS.includes(params.kind as Kind) ? (params.kind as Kind) : "tools")
  const blocks = createMemo<OverlayBlock[]>(() =>
    KINDS.map((id) => ({
      id,
      label: language.t(`operator.capabilities.${id}Label`),
      icon: (
        {
          tools: "console",
          skills: "brain",
          commands: "code",
          mcp: "mcp",
          agents: "brain",
          plugins: "sliders",
        } as const
      )[id],
      records: data.rows(id).map((row) => ({ id: row.name, label: id === "commands" ? `/${row.name}` : row.name })),
    })),
  )
  const row = () => data.rows(kind()).find((item) => item.name === params.item)
  const tool = () => (kind() === "tools" ? data.tools.data?.find((item) => item.id === params.item) : undefined)
  const command = () =>
    kind() === "commands" ? data.commands.data?.find((item) => item.name === params.item) : undefined
  const server = () => (kind() === "mcp" ? data.servers().find((item) => item.name === params.item) : undefined)

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
      <Show when={row()}>
        {(found) => (
          <RecordView
            title={
              kind() === "commands" ? (
                <code>/{found().name}</code>
              ) : kind() === "tools" ? (
                <code>{found().name}</code>
              ) : (
                found().name
              )
            }
            builtin={found().item?.origin === "opencode"}
            actions={
              <>
                <Show when={server()}>
                  {(item) => (
                    <ButtonV2
                      variant="outline"
                      disabled={mcpToggle.busy() === item().name}
                      onClick={() => void mcpToggle.toggle(item())}
                    >
                      {item().status.status === "connected"
                        ? language.t("operator.capabilities.disconnect")
                        : language.t("operator.capabilities.connect")}
                    </ButtonV2>
                  )}
                </Show>
                <CapabilityActions
                  item={found().item}
                  view={data.scope.view()}
                  directory={data.directory}
                  namespace={data.namespace}
                  onGone={gone}
                />
              </>
            }
          >
            <dl data-component="record-fields">
              <RecordField
                label={language.t("operator.capabilities.scope")}
                help={language.t("operator.help.capabilityOrigin")}
              >
                <span class="inline-flex items-center gap-2">
                  <OriginChip origin={found().item?.origin} />
                  <span data-testid="capability-state">{stateText(language, found().item)}</span>
                </span>
              </RecordField>
              <Show when={found().item?.location}>
                {(location) => (
                  <RecordField
                    label={language.t("operator.column.location")}
                    help={language.t("operator.help.capabilityLocation")}
                  >
                    <code>{location()}</code>
                  </RecordField>
                )}
              </Show>
              <Show when={found().item?.hides.length}>
                <RecordField
                  label={language.t("operator.capabilities.hides")}
                  help={language.t("operator.help.capabilityHides")}
                >
                  <ul>
                    <For each={found().item!.hides}>
                      {(hidden) => (
                        <li class="flex items-center gap-2">
                          <OriginChip origin={hidden.origin} />
                          <code>{hidden.location}</code>
                        </li>
                      )}
                    </For>
                  </ul>
                </RecordField>
              </Show>
              <Show when={found().item?.basedOn}>
                {(based) => (
                  <RecordField
                    label={language.t("operator.capabilities.basedOn")}
                    help={language.t("operator.help.capabilityBasedOn")}
                  >
                    <span data-testid="capability-based-on">
                      {language.t(
                        based().changed ? "operator.capabilities.basedOnChanged" : "operator.capabilities.basedOnSame",
                        { version: based().version },
                      )}
                    </span>
                  </RecordField>
                )}
              </Show>
              <Show
                when={
                  kind() === "commands" &&
                  found().name === "init" &&
                  found().item &&
                  found().item!.origin !== "opencode" &&
                  data.inventory.data?.namespace !== "opencode"
                }
              >
                <p data-slot="operator-note" data-warning="" data-testid="capability-init-hint">
                  {language.t("operator.capabilities.initHint")}
                </p>
              </Show>
              <Show when={found().item?.disabledAt}>
                {(at) => (
                  <RecordField
                    label={language.t("operator.capabilities.disabledAt")}
                    help={language.t("operator.help.capabilityDisabled")}
                  >
                    <span class="inline-flex items-center gap-2">
                      <OriginChip origin={at().origin} />
                      <code>{at().location}</code>
                    </span>
                  </RecordField>
                )}
              </Show>
              <Show when={found().description}>
                {(description) => (
                  <RecordField
                    label={language.t("operator.column.description")}
                    help={language.t("operator.help.toolDescription")}
                  >
                    <Show when={tool()} fallback={description()}>
                      <pre data-component="operator-code">{description()}</pre>
                    </Show>
                  </RecordField>
                )}
              </Show>
              <Show when={command()}>
                {(found) => (
                  <>
                    <RecordField
                      label={language.t("operator.column.agent")}
                      help={language.t("operator.help.commandAgent")}
                    >
                      {found().agent ?? "—"}
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
                  </>
                )}
              </Show>
              <Show when={server()}>
                {(found) => (
                  <>
                    <RecordField
                      label={language.t("operator.column.status")}
                      help={language.t("operator.help.mcpStatus")}
                    >
                      {language.t(`operator.capabilities.mcpStatus.${found().status.status}`)}
                      <Show when={"error" in found().status ? (found().status as { error: string }).error : undefined}>
                        {(error) => ` · ${error()}`}
                      </Show>
                    </RecordField>
                    <RecordField
                      label={language.t("operator.capabilities.toolsLabel")}
                      help={language.t("operator.help.mcpTools")}
                    >
                      <Show
                        when={(data.tools.data ?? []).filter((tool) => tool.source === found().name).length}
                        fallback="—"
                      >
                        <ul>
                          <For each={(data.tools.data ?? []).filter((tool) => tool.source === found().name)}>
                            {(tool) => (
                              <li>
                                <code>{tool.id}</code>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </RecordField>
                  </>
                )}
              </Show>
            </dl>
          </RecordView>
        )}
      </Show>
    </RecordOverlay>
  )
}
