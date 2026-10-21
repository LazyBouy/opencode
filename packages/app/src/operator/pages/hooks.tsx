import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { OperatorHook, OperatorHookEvent, OperatorHooksInForce } from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { formatAgo, shortPath } from "../format"
import { type Column, DataTable } from "../ui/data-table"
import { DetailOverlay } from "../ui/detail-overlay"
import { Field } from "../ui/field"
import { OverlayFrame } from "../ui/overlay-frame"
import { useOverlayParams } from "../ui/overlay-nav"
import { useProjectConfigWrite } from "../ui/project-config-copy"
import { useMoveToTrash } from "../ui/confirm"
import { useRecordOverlay } from "../ui/record-overlay"
import { SelectV2 } from "../ui/select"
import { requestError } from "./config-helpers"
import { actionsOf, isOwn, linesOf, namesOf, shownState, wouldDo } from "./hook-model"
import { HookRunOverlay, HookRunsList, OutcomeTag } from "./hook-runs"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Capabilities → Hooks (SPEC-0022 §10.1–§10.5): the hooks in force at the page's scope (a project, or a
// namespace's own layer), grouped by event in §5's order, with where each comes from and its state; a Runs view;
// a hook's overlay (Overview, Script, Test, Runs) with the form; and Settings → Hooks, an overlay of this tab (as
// Observability keeps its settings), so no upstream Settings file changes.

export type Scope = {
  directory: () => string | undefined
  namespace: () => string | undefined
  /** An agent's own hooks (its overlay and form) instead of the scope's. */
  agent?: () => string | undefined
}
const NEW = "@new"
const ANY = "@any"
const LANGUAGES = ["shell", "python", "javascript"] as const
const NEW_SCRIPT = "@new-script"

export function useHookData(scope: Scope) {
  const api = useOperatorClient()
  const list = useQuery(() => ({
    queryKey: api.key("hooks-in-force", scope.directory(), scope.namespace(), scope.agent?.()),
    enabled: !!scope.directory(),
    queryFn: () =>
      api
        .client()
        .operator.hook.list({
          directory: scope.directory(),
          ...(scope.namespace() ? { namespace: scope.namespace() } : {}),
          ...(scope.agent?.() ? { agent: scope.agent!() } : {}),
        })
        .then((result) => result.data!),
  }))
  const events = useQuery(() => ({
    queryKey: api.key("hook-events"),
    staleTime: Infinity,
    queryFn: () =>
      api
        .client()
        .operator.hook.events()
        .then((result) => result.data!),
  }))
  const eventOf = (name: string) => ready(events)?.find((item) => item.name === name)
  const order = (name: string) => {
    const at = (ready(events) ?? []).findIndex((item) => item.name === name)
    return at < 0 ? 99 : at
  }
  // The level the scope writes to: an agent's own, else the page's.
  const level = () => (scope.agent?.() ? ("agent" as const) : (ready(list)?.level ?? "project"))
  return { list, events, eventOf, order, level }
}

function useLevelWord() {
  const language = useLanguage()
  return (level: string) => language.t(`operator.levels.level.${level}` as Key)
}

export function HooksTab(props: Scope) {
  const language = useLanguage()
  const data = useHookData(props)
  const levelWord = useLevelWord()
  const [params, setParams] = useOverlayParams<{ hook?: string; hkind?: string; hview?: string; hsettings?: string }>()
  const [search, setSearch] = createSignal("")
  useRecordOverlay(
    () => !!params.hook,
    () => <HookOverlay {...props} />,
    ["hook", "htab", "hedit", "hfrom"],
  )
  useRecordOverlay(
    () => !!params.hsettings,
    () => <HookSettingsOverlay directory={props.directory} />,
    ["hsettings"],
  )
  const view = () => ready(data.list)
  const kind = () => (params.hkind === "blocking" || params.hkind === "watch" ? params.hkind : ANY)
  const rows = createMemo(() =>
    (view()?.hooks ?? [])
      .filter((hook) => kind() === ANY || data.eventOf(hook.event)?.kind === kind())
      .toSorted((a, b) => data.order(a.event) - data.order(b.event)),
  )
  const locale = () => language.intl()
  const columns = (): Column<OperatorHook>[] => {
    const level = view()?.level ?? "project"
    return [
      {
        id: "event",
        header: language.t("operator.hooks.column.event"),
        help: language.t("operator.hooks.help.event"),
        value: (hook) => data.order(hook.event),
        cell: (hook) => <code>{hook.event}</code>,
      },
      {
        id: "name",
        header: language.t("operator.column.name"),
        value: (hook) => hook.name,
        cell: (hook) => hook.name,
      },
      {
        id: "script",
        header: language.t("operator.hooks.column.script"),
        value: (hook) => hook.script,
        cell: (hook) => <span title={hook.command}>{hook.script}</span>,
      },
      {
        id: "match",
        header: language.t("operator.hooks.column.match"),
        help: language.t("operator.hooks.help.match"),
        cell: (hook) => hook.match.join(", ") || "—",
      },
      {
        id: "from",
        header: language.t("operator.hooks.column.from"),
        value: (hook) => hook.level,
        cell: (hook) => (
          <span title={hook.file}>
            {isOwn(hook, level) ? language.t("operator.hooks.here") : levelWord(hook.level)}
            <Show when={hook.locked && !isOwn(hook, level)}> 🔒</Show>
          </span>
        ),
      },
      {
        id: "state",
        header: language.t("operator.hooks.column.state"),
        value: (hook) => shownState(hook, level),
        cell: (hook) => (
          <span data-state={shownState(hook, level)} title={hook.problems.join("\n")}>
            {language.t(`operator.hooks.state.${shownState(hook, level)}` as Key)}
          </span>
        ),
      },
      {
        id: "last",
        header: language.t("operator.hooks.column.lastRun"),
        value: (hook) => hook.lastRun?.time ?? 0,
        cell: (hook) => (
          <Show when={hook.lastRun} fallback="—">
            {(last) => (
              <span class="inline-flex items-center gap-1">
                {formatAgo(last().time, locale())} <OutcomeTag outcome={last().outcome} />
              </span>
            )}
          </Show>
        ),
      },
      {
        id: "timeout",
        optional: true,
        hidden: true,
        header: language.t("operator.hooks.column.timeout"),
        value: (hook) => hook.timeout ?? 0,
        cell: (hook) => (hook.timeout !== undefined ? `${hook.timeout} s` : language.t("operator.hooks.default")),
      },
      {
        id: "onFailure",
        optional: true,
        hidden: true,
        header: language.t("operator.hooks.column.onFailure"),
        value: (hook) => hook.onFailure,
        cell: (hook) => language.t(`operator.hooks.onFailure.${hook.onFailure}` as Key),
      },
      {
        id: "description",
        optional: true,
        hidden: true,
        header: language.t("operator.column.description"),
        cell: (hook) => <span data-slot="operator-cell-clamp">{hook.description ?? ""}</span>,
      },
      {
        id: "today",
        optional: true,
        hidden: true,
        header: language.t("operator.hooks.column.today"),
        value: (hook) => hook.runsToday ?? 0,
        align: "end",
        cell: (hook) => String(hook.runsToday ?? 0),
      },
    ]
  }
  // A namespace's Runs: the runs of its hooks, by the files they're declared in.
  const files = createMemo(() => new Set((view()?.hooks ?? []).map((hook) => hook.file)))
  return (
    <div data-component="operator-hooks" data-testid="hooks-tab">
      <Show when={view()?.paused}>
        <p data-slot="operator-note" data-warning="" data-testid="hooks-paused">
          {language.t("operator.hooks.paused")}{" "}
          <button type="button" data-slot="operator-link" onClick={() => setParams({ hsettings: "1" })}>
            {language.t("operator.hooks.openSettings")}
          </button>
        </p>
      </Show>
      <Show when={view()?.pluginsOff}>
        <p data-slot="operator-note" data-warning="">
          {language.t("operator.hooks.pluginsOff")}
        </p>
      </Show>
      <div data-slot="operator-toolbar">
        <SegmentedControlV2
          aria-label={language.t("operator.hooks.view")}
          value={params.hview === "runs" ? "runs" : "list"}
          onChange={(value) => value && setParams({ hview: value === "runs" ? "runs" : undefined })}
          data-testid="hooks-view"
        >
          <SegmentedControlItemV2 value="list">{language.t("operator.hooks.view.list")}</SegmentedControlItemV2>
          <SegmentedControlItemV2 value="runs">{language.t("operator.hooks.view.runs")}</SegmentedControlItemV2>
        </SegmentedControlV2>
        <Show when={params.hview !== "runs"}>
          <TextInputV2
            type="search"
            appearance="base"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder={language.t("operator.hooks.search")}
            aria-label={language.t("operator.hooks.search")}
          />
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.hooks.kind")}
            options={[ANY, "blocking", "watch"]}
            current={kind()}
            label={(value) => language.t(`operator.hooks.kind.${value === ANY ? "all" : value}` as Key)}
            onSelect={(value) => value !== null && setParams({ hkind: value === ANY ? undefined : value })}
          />
          <ButtonV2 size="small" variant="outline" onClick={() => setParams({ hook: NEW, htab: "overview" })}>
            {language.t("operator.hooks.new")}
          </ButtonV2>
        </Show>
        <ButtonV2 size="small" variant="ghost" onClick={() => setParams({ hsettings: "1" })}>
          {language.t("operator.hooks.settings")}
        </ButtonV2>
      </div>
      <Show
        when={params.hview === "runs"}
        fallback={
          <DataTable
            columnsKey="hooks"
            label={language.t("operator.hooks.label")}
            rows={rows()}
            loading={data.list.isPending}
            columns={columns()}
            filter={search()}
            search={(hook) => `${hook.name} ${hook.event} ${hook.script} ${hook.description ?? ""}`}
            initialSort={{ column: "event", direction: "asc" }}
            empty={language.t("operator.hooks.none")}
            onRowClick={(hook) => setParams({ hook: hook.name, htab: "overview" })}
          />
        }
      >
        <HookRunsList
          source={{
            directory: props.directory,
            ...(props.namespace() ? { scope: "all" as const, keep: (run) => files().has(run.file) } : {}),
          }}
        />
      </Show>
      <HookRunHost directory={props.directory} />
    </div>
  )
}

// A run opened from any list on the page.
export { HookForm, useHookActions }

export function HookRunHost(props: { directory: () => string | undefined }) {
  const [params] = useOverlayParams<{ hrun?: string }>()
  useRecordOverlay(
    () => !!params.hrun,
    () => <HookRunOverlay directory={props.directory} />,
    ["hrun"],
  )
  return null
}

// A hook's overlay: Overview (its fields, then Edit, Test, Delete or the inherited actions), Script, Test, Runs.
// `?hook=@new` is the form for a new hook; `hedit=1` edits; an inherited hook's Override opens the form with its
// fields at this level.
function HookOverlay(props: Scope) {
  const language = useLanguage()
  const data = useHookData(props)
  const [params, setParams] = useOverlayParams<{ hook?: string; htab?: string; hedit?: string; hfrom?: string }>()
  const creating = () => params.hook === NEW
  const hook = () => ready(data.list)?.hooks.find((item) => item.name === params.hook)
  const tab = () => (creating() ? "overview" : (params.htab ?? "overview"))
  const sections = () =>
    (creating() ? ["overview"] : ["overview", "script", "test", "runs"]).map((id) => ({
      id,
      label: language.t(`operator.hooks.tab.${id}` as Key),
      icon: ({ overview: "eye", script: "code", test: "console", runs: "bullet-list" } as const)[
        id as "overview" | "script" | "test" | "runs"
      ],
    }))
  return (
    <DetailOverlay
      title={creating() ? language.t("operator.hooks.new") : (params.hook ?? "")}
      sections={sections()}
      section={tab()}
      records={(ready(data.list)?.hooks ?? []).map((item) => item.name)}
      record={params.hook ?? ""}
      editing={creating() || params.hedit === "1"}
      onSection={(id) => setParams({ htab: id })}
      onRecord={(name) => setParams({ hook: name, hedit: undefined, hfrom: undefined })}
    >
      <Switch>
        <Match when={creating() || params.hedit === "1"}>
          <HookForm
            scope={props}
            view={ready(data.list)}
            hook={creating() ? undefined : hook()}
            onDone={(name) => setParams({ hook: name, hedit: undefined, htab: "overview", hfrom: undefined })}
            onCancel={() =>
              creating() ? setParams({ hook: undefined, hfrom: undefined }) : setParams({ hedit: undefined })
            }
          />
        </Match>
        <Match when={hook()}>
          {(found) => (
            <Switch>
              <Match when={tab() === "overview"}>
                <HookOverview
                  scope={props}
                  view={ready(data.list)!}
                  hook={found()}
                  event={data.eventOf(found().event)}
                />
              </Match>
              <Match when={tab() === "script"}>
                <HookScript scope={props} hook={found()} />
              </Match>
              <Match when={tab() === "test"}>
                <HookTest scope={props} hook={found()} />
              </Match>
              <Match when={tab() === "runs"}>
                <HookRunsList
                  source={{
                    directory: props.directory,
                    hook: () => found().name,
                    scope: "all",
                    keep: (run) => run.file === found().file,
                  }}
                  testid="hook-runs-of"
                />
              </Match>
            </Switch>
          )}
        </Match>
        <Match when={!data.list.isPending}>
          <p data-slot="operator-note">{language.t("operator.hooks.missing")}</p>
        </Match>
      </Switch>
    </DetailOverlay>
  )
}

function useHookActions(scope: Scope) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const write = useProjectConfigWrite()
  const moveToTrash = useMoveToTrash()
  const where = () => ({
    directory: scope.directory(),
    ...(scope.namespace() ? { namespace: scope.namespace() } : {}),
    ...(scope.agent?.() ? { agent: scope.agent!() } : {}),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.key() })
  const failed = (name: string) => (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("operator.hooks.failed", { name }),
      description: requestError(error),
    })
  return {
    where,
    refresh,
    setState: (name: string, off: boolean) =>
      write((confirmCopy) =>
        api
          .client()
          .operator.hook.state(
            { ...where(), name, off, ...(confirmCopy ? { confirmCopy } : {}) },
            { throwOnError: true },
          ),
      )
        .then(refresh)
        .catch(failed(name)),
    remove: (hook: OperatorHook, script: boolean, done: () => void) =>
      moveToTrash(hook.name, () =>
        write((confirmCopy) =>
          api
            .client()
            .operator.hook.remove(
              { ...where(), name: hook.name, script, ...(confirmCopy ? { confirmCopy } : {}) },
              { throwOnError: true },
            ),
        ).then(async (result) => {
          if (!result) return
          await refresh()
          done()
        }),
      ),
  }
}

function HookOverview(props: {
  scope: Scope
  view: OperatorHooksInForce
  hook: OperatorHook
  event: OperatorHookEvent | undefined
}) {
  const language = useLanguage()
  const levelWord = useLevelWord()
  const actions = useHookActions(props.scope)
  const [, setParams] = useOverlayParams<{ hook?: string; htab?: string; hedit?: string; hfrom?: string }>()
  const [script, setScript] = createSignal(false)
  const allowed = () => actionsOf(props.hook, props.view.level)
  const fact = (label: string, help: string, value: string) => (
    <>
      <dt>{label}</dt>
      <dd title={help}>{value}</dd>
    </>
  )
  const own = () => isOwn(props.hook, props.view.level)
  return (
    <div data-component="operator-hook-overview" data-testid="hook-overview">
      <section data-component="operator-panel">
        <dl data-component="operator-facts" data-layout="stacked">
          {fact(language.t("operator.hooks.column.event"), language.t("operator.hooks.help.event"), props.hook.event)}
          {fact(language.t("operator.hooks.column.script"), props.hook.command, props.hook.script)}
          {fact(language.t("operator.hooks.field.args"), "", props.hook.args.join(" ") || "—")}
          {fact(
            language.t("operator.hooks.column.match"),
            language.t("operator.hooks.help.match"),
            props.hook.match.join(", ") || "—",
          )}
          {fact(
            language.t("operator.hooks.column.timeout"),
            "",
            props.hook.timeout !== undefined ? `${props.hook.timeout} s` : language.t("operator.hooks.default"),
          )}
          {fact(
            language.t("operator.hooks.column.onFailure"),
            "",
            language.t(`operator.hooks.onFailure.${props.hook.onFailure}` as Key),
          )}
          {fact(
            language.t("operator.hooks.field.locked"),
            "",
            language.t(props.hook.locked ? "operator.hooks.lockedYes" : "operator.hooks.lockedNo"),
          )}
          {fact(
            language.t("operator.hooks.column.from"),
            props.hook.file,
            `${own() ? language.t("operator.hooks.here") : levelWord(props.hook.level)} · ${shortPath(props.hook.file)}`,
          )}
          {fact(
            language.t("operator.hooks.column.state"),
            "",
            language.t(`operator.hooks.state.${shownState(props.hook, props.view.level)}` as Key),
          )}
          <Show when={props.hook.replaces}>
            {(replaced) =>
              fact(
                language.t("operator.hooks.replaces"),
                replaced().file,
                `${levelWord(replaced().level)} · ${shortPath(replaced().file)}`,
              )
            }
          </Show>
          <Show when={props.hook.description}>
            {(text) => fact(language.t("operator.column.description"), "", text())}
          </Show>
        </dl>
        <Show when={props.hook.problems.length}>
          <ul data-slot="operator-plain-list" data-testid="hook-problems">
            <For each={props.hook.problems}>{(problem) => <li data-slot="operator-error">{problem}</li>}</For>
          </ul>
        </Show>
        <Show when={props.event}>
          {(event) => <p data-slot="operator-note">{language.t(`operator.hooks.event.${event().name}` as Key)}</p>}
        </Show>
      </section>
      <div data-slot="operator-actions" class="flex gap-2 flex-wrap">
        <Show when={allowed().edit}>
          <ButtonV2 size="small" onClick={() => setParams({ hedit: "1" })}>
            {language.t("operator.hooks.edit")}
          </ButtonV2>
        </Show>
        <ButtonV2 size="small" variant="outline" onClick={() => setParams({ htab: "test" })}>
          {language.t("operator.hooks.test")}
        </ButtonV2>
        <Show when={allowed().override}>
          <ButtonV2
            size="small"
            variant="outline"
            onClick={() => setParams({ hook: NEW, hedit: undefined, htab: "overview", hfrom: props.hook.name })}
          >
            {language.t("operator.hooks.override")}
          </ButtonV2>
        </Show>
        <Show when={allowed().turnOff}>
          <ButtonV2 size="small" variant="outline" onClick={() => void actions.setState(props.hook.name, true)}>
            {language.t("operator.hooks.turnOff")}
          </ButtonV2>
        </Show>
        <Show when={allowed().turnOn}>
          <ButtonV2 size="small" variant="outline" onClick={() => void actions.setState(props.hook.name, false)}>
            {language.t("operator.hooks.turnOn")}
          </ButtonV2>
        </Show>
        <Show when={allowed().remove}>
          <CheckboxV2
            label={language.t("operator.hooks.removeScript")}
            checked={script()}
            onChange={(value: boolean) => setScript(value)}
          />
          <ButtonV2
            size="small"
            variant="ghost"
            onClick={() => void actions.remove(props.hook, script(), () => setParams({ hook: undefined }))}
          >
            {language.t("operator.hooks.delete")}
          </ButtonV2>
        </Show>
        <Show when={props.hook.locked && !own()}>
          <p data-slot="operator-note">
            {language.t("operator.hooks.lockedNote", { level: levelWord(props.hook.level) })}
          </p>
        </Show>
      </div>
    </div>
  )
}

// The form (§10.2): name, event, script (one of the scope's, or a new one from a template), arguments, matches,
// timeout, on failure, "can be turned off below", enabled, description. Saving writes the scope's config (a
// project's: the copy question).
function HookForm(props: {
  scope: Scope
  view: OperatorHooksInForce | undefined
  hook: OperatorHook | undefined
  onDone: (name: string) => void
  onCancel: () => void
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const data = useHookData(props.scope)
  const actions = useHookActions(props.scope)
  const write = useProjectConfigWrite()
  const [params] = useOverlayParams<{ hfrom?: string }>()
  // Override here: the inherited hook's fields, at this level, under its name.
  const from = () =>
    props.hook ?? (params.hfrom ? props.view?.hooks.find((item) => item.name === params.hfrom) : undefined)
  const seed = from()
  const [store, setStore] = createStore({
    name: seed?.name ?? "",
    event: seed?.event ?? "tool.before",
    command: seed?.script ?? "",
    args: (seed?.args ?? []).join("\n"),
    match: (seed?.match ?? []).join(", "),
    timeout: seed?.timeout !== undefined ? String(seed.timeout) : "",
    onFailure: seed?.onFailure ?? "deny",
    locked: seed?.locked ?? false,
    enabled: seed?.enabled ?? true,
    description: seed?.description ?? "",
    newScript: "",
    language: "shell" as (typeof LANGUAGES)[number],
    busy: false,
    error: "",
  })
  const scripts = useQuery(() => ({
    queryKey: api.key("hook-scripts", props.scope.directory(), props.scope.namespace()),
    enabled: !!props.scope.directory(),
    queryFn: () =>
      api
        .client()
        .operator.hook.scripts({
          directory: props.scope.directory(),
          ...(props.scope.namespace() ? { namespace: props.scope.namespace() } : {}),
        })
        .then((result) => result.data ?? []),
  }))
  const folder = () => props.view?.folder
  const relative = (file: string) => {
    const base = folder() ? folder()!.slice(0, folder()!.lastIndexOf("/")) : ""
    return base && file.startsWith(base + "/") ? file.slice(base.length + 1) : file
  }
  const scriptOptions = createMemo(() => [
    ...new Set([...(ready(scripts) ?? []).map(relative), ...(store.command ? [store.command] : [])]),
    NEW_SCRIPT,
  ])
  const event = () => data.eventOf(store.event)
  const overrides = () =>
    !props.hook && props.view?.hooks.some((item) => item.name === store.name && !isOwn(item, data.level()))
  createEffect(
    on(
      () => store.event,
      () => event()?.subject || setStore("match", ""),
      { defer: true },
    ),
  )

  const makeScript = async () => {
    setStore({ busy: true, error: "" })
    try {
      const made = await api.client().operator.hook.newScript(
        {
          directory: props.scope.directory(),
          ...(props.scope.namespace() ? { namespace: props.scope.namespace() } : {}),
          name: store.newScript || store.name || "hook",
          language: store.language,
          event: store.event as never,
        },
        { throwOnError: true },
      )
      await scripts.refetch()
      setStore({ command: made.data!.command, newScript: "" })
    } catch (error) {
      setStore("error", requestError(error))
    } finally {
      setStore("busy", false)
    }
  }
  const save = async () => {
    setStore({ busy: true, error: "" })
    const timeout = store.timeout.trim() === "" ? undefined : Number(store.timeout)
    try {
      const result = await write((confirmCopy) =>
        api.client().operator.hook.save(
          {
            ...actions.where(),
            name: store.name.trim(),
            ...(props.hook && props.hook.name !== store.name.trim() ? { previous: props.hook.name } : {}),
            hook: {
              event: store.event,
              command: store.command,
              ...(linesOf(store.args).length ? { args: linesOf(store.args) } : {}),
              ...(event()?.subject && namesOf(store.match).length ? { match: namesOf(store.match) } : {}),
              ...(timeout !== undefined ? { timeout } : {}),
              ...(event()?.kind === "blocking" && store.onFailure === "allow" ? { onFailure: "allow" } : {}),
              ...(store.locked ? { locked: true } : {}),
              ...(store.enabled ? {} : { enabled: false }),
              ...(store.description.trim() ? { description: store.description.trim() } : {}),
            },
            ...(confirmCopy ? { confirmCopy } : {}),
          },
          { throwOnError: true },
        ),
      )
      if (!result) return
      await actions.refresh()
      props.onDone(store.name.trim())
    } catch (error) {
      setStore("error", requestError(error))
    } finally {
      setStore("busy", false)
    }
  }
  const groups = createMemo(() => {
    const out: Array<{ group: string; events: OperatorHookEvent[] }> = []
    for (const item of ready(data.events) ?? []) {
      const last = out.at(-1)
      if (last?.group === item.group) last.events.push(item)
      else out.push({ group: item.group, events: [item] })
    }
    return out
  })
  return (
    <form
      data-component="operator-hook-form"
      data-testid="hook-form"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <Field label={language.t("operator.column.name")} hint={language.t("operator.hooks.help.name")}>
        <TextInputV2
          appearance="base"
          value={store.name}
          onInput={(event) => setStore("name", event.currentTarget.value)}
        />
      </Field>
      <Show when={overrides()}>
        <p data-slot="operator-note" data-testid="hook-overrides">
          {language.t("operator.hooks.overridesNote", { name: store.name })}
        </p>
      </Show>
      <Field
        group
        label={language.t("operator.hooks.column.event")}
        hint={language.t(`operator.hooks.event.${store.event}` as Key)}
      >
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.hooks.column.event")}
          options={groups().flatMap((group) => group.events.map((item) => item.name))}
          current={store.event}
          label={(value) =>
            `${language.t(`operator.hooks.group.${data.eventOf(value)?.group ?? "watch"}` as Key)} · ${value}`
          }
          onSelect={(value) => value && setStore("event", value)}
        />
      </Field>
      <Field group label={language.t("operator.hooks.column.script")} hint={language.t("operator.hooks.help.script")}>
        <SelectV2<string>
          appearance="base"
          aria-label={language.t("operator.hooks.column.script")}
          options={scriptOptions()}
          current={store.command || undefined}
          label={(value) => (value === NEW_SCRIPT ? language.t("operator.hooks.newScript") : value)}
          onSelect={(value) => value && setStore("command", value === NEW_SCRIPT ? NEW_SCRIPT : value)}
        />
      </Field>
      <Show when={store.command === NEW_SCRIPT}>
        <div data-slot="operator-toolbar" data-testid="hook-new-script">
          <TextInputV2
            appearance="base"
            value={store.newScript}
            placeholder={store.name || "hook"}
            aria-label={language.t("operator.hooks.newScriptName")}
            onInput={(event) => setStore("newScript", event.currentTarget.value)}
          />
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.hooks.language")}
            options={[...LANGUAGES]}
            current={store.language}
            label={(value) => language.t(`operator.hooks.language.${value}` as Key)}
            onSelect={(value) => value && setStore("language", value as (typeof LANGUAGES)[number])}
          />
          <ButtonV2 size="small" variant="outline" disabled={store.busy} onClick={() => void makeScript()}>
            {language.t("operator.hooks.writeScript")}
          </ButtonV2>
        </div>
      </Show>
      <Field label={language.t("operator.hooks.field.args")} hint={language.t("operator.hooks.help.args")}>
        <TextareaV2 rows={2} value={store.args} onInput={(event) => setStore("args", event.currentTarget.value)} />
      </Field>
      <Show when={event()?.subject}>
        {(subject) => (
          <Field
            label={language.t("operator.hooks.column.match")}
            hint={language.t(`operator.hooks.help.match.${subject()}` as Key)}
          >
            <TextInputV2
              appearance="base"
              value={store.match}
              onInput={(event) => setStore("match", event.currentTarget.value)}
            />
          </Field>
        )}
      </Show>
      <Field label={language.t("operator.hooks.column.timeout")} hint={language.t("operator.hooks.help.timeout")}>
        <TextInputV2
          appearance="base"
          inputMode="decimal"
          value={store.timeout}
          placeholder={language.t("operator.hooks.default")}
          onInput={(event) => setStore("timeout", event.currentTarget.value)}
        />
      </Field>
      <Show when={event()?.kind === "blocking"}>
        <Field
          group
          label={language.t("operator.hooks.column.onFailure")}
          hint={language.t("operator.hooks.help.onFailure")}
        >
          <SelectV2<string>
            appearance="base"
            aria-label={language.t("operator.hooks.column.onFailure")}
            options={["deny", "allow"]}
            current={store.onFailure}
            label={(value) => language.t(`operator.hooks.onFailure.${value}` as Key)}
            onSelect={(value) => value && setStore("onFailure", value as "deny" | "allow")}
          />
        </Field>
      </Show>
      <CheckboxV2
        label={language.t("operator.hooks.field.turnOffBelow")}
        checked={!store.locked}
        onChange={(value: boolean) => setStore("locked", !value)}
      />
      <CheckboxV2
        label={language.t("operator.hooks.field.enabled")}
        checked={store.enabled}
        onChange={(value: boolean) => setStore("enabled", value)}
      />
      <Field label={language.t("operator.column.description")} hint={language.t("operator.hooks.help.description")}>
        <TextInputV2
          appearance="base"
          value={store.description}
          onInput={(event) => setStore("description", event.currentTarget.value)}
        />
      </Field>
      <Show when={store.error}>
        <pre data-slot="operator-error" role="alert">
          {store.error}
        </pre>
      </Show>
      <div data-slot="operator-actions" class="flex gap-2">
        <ButtonV2
          type="submit"
          size="small"
          disabled={store.busy || !store.name.trim() || !store.command || store.command === NEW_SCRIPT}
        >
          {language.t("operator.hooks.save")}
        </ButtonV2>
        <ButtonV2 type="button" size="small" variant="ghost" onClick={props.onCancel}>
          {language.t("operator.hooks.cancel")}
        </ButtonV2>
      </div>
    </form>
  )
}

// The Script tab: the script's text, editable when it's in the scope's hooks/ folder.
function HookScript(props: { scope: Scope; hook: OperatorHook }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const actions = useHookActions(props.scope)
  const script = useQuery(() => ({
    queryKey: api.key("hook-script", props.scope.directory(), props.scope.namespace(), props.hook.command),
    retry: false,
    queryFn: () =>
      api
        .client()
        .operator.hook.script({ ...actions.where(), path: props.hook.command }, { throwOnError: true })
        .then((result) => result.data!),
  }))
  const [text, setText] = createSignal<string>()
  const [state, setState] = createStore({ busy: false, saved: false, error: "" })
  const save = async () => {
    setState({ busy: true, saved: false, error: "" })
    try {
      await api
        .client()
        .operator.hook.saveScript(
          { ...actions.where(), path: props.hook.command, text: text() ?? "" },
          { throwOnError: true },
        )
      await script.refetch()
      setText(undefined)
      setState("saved", true)
    } catch (error) {
      setState("error", requestError(error))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <div data-component="operator-hook-script" data-testid="hook-script">
      <p data-slot="operator-note">{props.hook.command}</p>
      <Show
        when={ready(script)}
        fallback={
          <p data-slot="operator-note">{script.isError ? requestError(script.error) : language.t("common.loading")}</p>
        }
      >
        {(found) => (
          <>
            <Show when={!found().editable}>
              <p data-slot="operator-note">{language.t("operator.hooks.scriptReadOnly")}</p>
            </Show>
            <TextareaV2
              rows={18}
              readOnly={!found().editable}
              value={text() ?? found().text}
              aria-label={language.t("operator.hooks.column.script")}
              onInput={(event) => setText(event.currentTarget.value)}
            />
            <Show when={found().editable}>
              <div data-slot="operator-actions" class="flex gap-2 items-center">
                <ButtonV2 size="small" disabled={state.busy || text() === undefined} onClick={() => void save()}>
                  {language.t("operator.hooks.saveScript")}
                </ButtonV2>
                <Show when={state.saved}>
                  <span data-slot="operator-note">{language.t("operator.hooks.scriptSaved")}</span>
                </Show>
              </div>
            </Show>
            <Show when={state.error}>
              <pre data-slot="operator-error" role="alert">
                {state.error}
              </pre>
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

// The Test tab (§10.4): a sample event, editable as JSON; Run executes the script as a real run would, in its
// level's folder; the result shows the outcome, exit code, duration, stdout and stderr, and what the answer
// would do.
function HookTest(props: { scope: Scope; hook: OperatorHook }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const actions = useHookActions(props.scope)
  const sample = useQuery(() => ({
    queryKey: api.key("hook-sample", props.hook.event),
    queryFn: () =>
      api
        .client()
        .operator.hook.sample({ directory: props.scope.directory(), event: props.hook.event as never })
        .then((result) => result.data!),
  }))
  const [text, setText] = createSignal<string>()
  const [state, setState] = createStore<{
    busy: boolean
    error: string
    result?: Awaited<ReturnType<ReturnType<typeof api.client>["operator"]["hook"]["test"]>>["data"]
  }>({ busy: false, error: "" })
  const input = () =>
    text() ?? JSON.stringify({ ...ready(sample)?.input, hook: props.hook.name, level: props.hook.level }, null, 2)
  const run = async () => {
    setState({ busy: true, error: "", result: undefined })
    try {
      const parsed = JSON.parse(input()) as Record<string, unknown>
      const result = await api
        .client()
        .operator.hook.test({ ...actions.where(), name: props.hook.name, input: parsed }, { throwOnError: true })
      setState("result", result.data)
    } catch (error) {
      setState("error", error instanceof SyntaxError ? language.t("operator.hooks.badJson") : requestError(error))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <div data-component="operator-hook-test" data-testid="hook-test">
      <Field label={language.t("operator.hooks.testInput")} hint={language.t("operator.hooks.help.testInput")}>
        <TextareaV2 rows={14} value={input()} onInput={(event) => setText(event.currentTarget.value)} />
      </Field>
      <div data-slot="operator-actions" class="flex gap-2">
        <ButtonV2 size="small" disabled={state.busy} onClick={() => void run()}>
          {language.t("operator.hooks.run")}
        </ButtonV2>
      </div>
      <Show when={state.error}>
        <pre data-slot="operator-error" role="alert">
          {state.error}
        </pre>
      </Show>
      <Show when={state.result}>
        {(result) => (
          <section data-component="operator-panel" data-testid="hook-test-result">
            <div class="flex items-center gap-2 flex-wrap">
              <OutcomeTag outcome={result().outcome} />
              <span data-slot="operator-note">
                {language.t("operator.hooks.testFacts", {
                  exit: String(result().run.exitCode ?? "—"),
                  duration: String(result().run.durationMs ?? 0),
                })}
              </span>
            </div>
            <ul data-slot="operator-plain-list" data-testid="hook-test-would">
              <For
                each={wouldDo({
                  event: props.hook.event,
                  outcome: result().outcome,
                  answer: result().answer,
                  ...(result().cause ? { cause: result().cause } : {}),
                  onFailure: props.hook.onFailure,
                })}
              >
                {(words) => <li>{language.t(words.key as Key, words.values)}</li>}
              </For>
            </ul>
            <Show when={result().run.stdout}>
              <h3 data-slot="operator-panel-title">{language.t("operator.hooks.run.stdout")}</h3>
              <pre data-component="operator-code">{result().run.stdout}</pre>
            </Show>
            <Show when={result().run.stderr}>
              <h3 data-slot="operator-panel-title">{language.t("operator.hooks.run.stderr")}</h3>
              <pre data-component="operator-code">{result().run.stderr}</pre>
            </Show>
          </section>
        )}
      </Show>
    </div>
  )
}

// Settings → Hooks (§10.5), server-wide: the default timeout and Pause all hooks.
function HookSettingsOverlay(props: { directory: () => string | undefined }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const queryClient = useQueryClient()
  const settings = useQuery(() => ({
    queryKey: api.key("hook-settings"),
    queryFn: () =>
      api
        .client()
        .operator.hook.settings({ directory: props.directory() })
        .then((result) => result.data!),
  }))
  const [store, setStore] = createStore({ timeout: "", busy: false, error: "", dirty: false })
  createEffect(
    on(
      () => ready(settings)?.timeout,
      (timeout) => timeout !== undefined && !store.dirty && setStore("timeout", String(timeout)),
    ),
  )
  const save = async (patch: { timeout?: number; paused?: boolean }) => {
    setStore({ busy: true, error: "" })
    try {
      await api.client().operator.hook.saveSettings({ directory: props.directory(), ...patch }, { throwOnError: true })
      setStore("dirty", false)
      await queryClient.invalidateQueries({ queryKey: api.key() })
    } catch (error) {
      setStore("error", requestError(error))
    } finally {
      setStore("busy", false)
    }
  }
  return (
    <OverlayFrame label={language.t("operator.hooks.settingsTitle")} editing={store.dirty}>
      <div data-component="operator-hook-settings" data-testid="hook-settings">
        <section data-component="operator-panel">
          <h3 data-slot="operator-panel-title">{language.t("operator.hooks.settingsTitle")}</h3>
          <Field
            label={language.t("operator.hooks.defaultTimeout")}
            hint={language.t("operator.hooks.help.defaultTimeout")}
          >
            <TextInputV2
              appearance="base"
              inputMode="decimal"
              value={store.timeout}
              onInput={(event) => setStore({ timeout: event.currentTarget.value, dirty: true })}
            />
          </Field>
          <div data-slot="operator-actions" class="flex gap-2">
            <ButtonV2
              size="small"
              disabled={store.busy || !store.dirty}
              onClick={() => void save({ timeout: Number(store.timeout) })}
            >
              {language.t("operator.hooks.save")}
            </ButtonV2>
          </div>
          <CheckboxV2
            label={language.t("operator.hooks.pause")}
            checked={ready(settings)?.paused ?? false}
            onChange={(value: boolean) => void save({ paused: value })}
          />
          <p data-slot="operator-note">{language.t("operator.hooks.help.pause")}</p>
          <Show when={store.error}>
            <pre data-slot="operator-error" role="alert">
              {store.error}
            </pre>
          </Show>
        </section>
      </div>
    </OverlayFrame>
  )
}
