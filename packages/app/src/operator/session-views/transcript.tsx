import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type {
  OperatorCallDetail,
  OperatorCallList,
  OperatorCallSummary,
  OperatorTurn,
} from "@opencode-ai/sdk/v2/client"
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/solid-query"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { ready, useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import {
  AccountingTable,
  ChangesPart,
  InputBreakdown,
  SentDetail,
  SessionTotalsView,
  TurnHeader,
  UnrecordedRow,
} from "./accounting"
import { createScrollAnchor, keepInPlace } from "./anchor"
import { prettyArgs } from "./content"
import { useOpenSessionView, useSessionView } from "./view"
import "./session-views.css"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Language = ReturnType<typeof useLanguage>
type Filter = "all" | "agent" | "side" | "errors"
const FILTERS: Filter[] = ["all", "agent", "side", "errors"]
const SIDE = new Set(["title", "compaction", "summary", "other", "unlinked"])

// The Transcript view: every model call of the session, by turn (a user message and everything the
// agent did for it), each with its token accounting (every billed token in one row: accounting.tsx),
// what it sent and received, and the exact request body and response a click away. Read-only; it
// follows a running session.
export function TranscriptView(props: { sessionID: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const queryClient = useQueryClient()
  const view = useSessionView()
  const [store, setStore] = createStore({
    filter: "all" as Filter,
    search: "",
    onlyNew: false,
    expanded: false,
    folded: {} as Record<number, boolean>,
  })
  const session = useQuery(() => ({
    queryKey: api.key("session", props.sessionID),
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: props.sessionID })
        .then((result) => result.data!),
  }))
  // Every read goes through ready(): a query still loading must not suspend the page (its scroll resets).
  const directory = () => ready(session)?.directory
  const list = useQuery(() => ({
    queryKey: api.key("calls", props.sessionID),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.call.list({ sessionID: props.sessionID, directory: directory() })
        .then((result) => result.data!),
    placeholderData: keepPreviousData,
  }))
  const data = () => ready(list)

  // New calls appear as they start; a call's response completes it.
  const stop = serverSdk().event.listen((event) => {
    const details = event.details as { type?: string; properties?: { sessionID?: string; callID?: string } }
    if (details?.properties?.sessionID !== props.sessionID) return
    if (details.type !== "operator.call.recorded" && details.type !== "operator.call.updated") return
    void list.refetch()
    if (details.type === "operator.call.updated" && details.properties.callID)
      void queryClient.invalidateQueries({ queryKey: api.key("call", props.sessionID, details.properties.callID) })
  })
  onCleanup(stop)

  // Search: the server looks through what each call sent and received (after a pause in typing); the
  // exchange's own text, the model and the agent are matched here.
  const [settled, setSettled] = createSignal("")
  createEffect(
    on(
      () => store.search.trim(),
      (value) => {
        const timer = setTimeout(() => setSettled(value), 300)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )
  const searched = useQuery(() => ({
    queryKey: api.key("calls-search", props.sessionID, settled()),
    enabled: !!directory() && !!settled(),
    queryFn: () =>
      api
        .client()
        .operator.call.list({ sessionID: props.sessionID, directory: directory(), search: settled() })
        .then((result) => new Set(result.data!.calls.map((call) => call.callID))),
    placeholderData: keepPreviousData,
  }))
  const matches = (call: OperatorCallSummary) => {
    if (store.filter === "errors") return call.failed
    if (store.filter === "agent" && (call.kind !== "agent" || call.failed)) return false
    if (store.filter === "side" && !SIDE.has(call.kind)) return false
    const search = store.search.trim().toLowerCase()
    if (!search) return true
    if (ready(searched)?.has(call.callID)) return true
    const exchange = data()?.exchanges.find((item) => item.index === call.exchange)
    return [call.model, call.agent, call.kind, exchange?.text]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search))
  }
  const calls = createMemo(() => (data()?.calls ?? []).filter(matches))
  const byID = createMemo(() => new Map((data()?.calls ?? []).map((call) => [call.callID, call])))
  // The turns in order (the list's own objects, so cards stay as the list refreshes), each with its
  // calls that pass the filter (side calls where they happened) and the steps that were not recorded.
  const shown = createMemo(() => new Set(calls().map((call) => call.callID)))
  const filtering = () => store.filter !== "all" || !!store.search.trim()
  const callsOf = (turn: OperatorTurn) => turn.calls.filter((id) => shown().has(id)).map((id) => byID().get(id)!)
  const unrecordedOf = (turn: OperatorTurn) =>
    filtering() ? [] : (data()?.unrecorded ?? []).filter((step) => (step.exchange ?? 0) === turn.index)
  const exchangeTime = (index: number) => data()?.exchanges.find((item) => item.index === index)?.time
  const recount = async () => {
    await api
      .client()
      .operator.call.recount({ sessionID: props.sessionID, directory: directory() }, { throwOnError: true })
      .then(() => queryClient.invalidateQueries({ queryKey: api.key("call", props.sessionID) }))
      .then(() => list.refetch())
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.transcript.exportFailed"), description: requestError(error) }),
      )
  }
  const tokenizers = useQuery(() => ({
    queryKey: api.key("tokenizers"),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.call.tokenizers({ directory: directory() })
        .then((result) => result.data!),
  }))
  const download = async (format: "md" | "json") => {
    await api
      .client()
      .operator.call.export({ sessionID: props.sessionID, directory: directory(), format })
      .then((result) => {
        const blob = new Blob([result.data?.text ?? ""], {
          type: format === "md" ? "text/markdown" : "application/json",
        })
        const link = document.createElement("a")
        link.href = URL.createObjectURL(blob)
        link.download = `transcript-${props.sessionID}.${format}`
        link.click()
        URL.revokeObjectURL(link.href)
      })
      .catch((error: unknown) =>
        showToast({ title: language.t("operator.transcript.exportFailed"), description: requestError(error) }),
      )
  }

  // What the reader sees stays in place as the transcript grows or shrinks around it (anchor.ts).
  let root: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  onMount(() => {
    const head = root?.querySelector<HTMLElement>('[data-slot="operator-transcript-head"]')
    if (root && content) onCleanup(createScrollAnchor(root, head ? [head, content] : [content]))
  })

  // A link to one call (`?call=`) scrolls to it once it is listed: once per selection, never again when
  // the list refreshes.
  let scrolledTo: string | undefined
  createEffect(() => {
    const id = view.call()
    if (!id || id === scrolledTo || !calls().some((call) => call.callID === id)) return
    scrolledTo = id
    requestAnimationFrame(() =>
      document.querySelector(`[data-call-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" }),
    )
  })

  return (
    <div data-component="operator-transcript" data-testid="transcript" ref={root}>
      <header data-slot="operator-transcript-head">
        <Show when={data()}>
          {(data) => (
            <>
              <SessionTotalsView list={data()} />
              <InputBreakdown list={data()} />
            </>
          )}
        </Show>
        <div data-slot="operator-transcript-tools">
          <SegmentedControlV2
            class="operator-segmented-fit"
            value={store.filter}
            onChange={(value) => value && setStore("filter", value as Filter)}
            aria-label={language.t("operator.transcript.filter")}
          >
            <For each={FILTERS}>
              {(filter) => (
                <SegmentedControlItemV2 value={filter}>
                  {language.t(`operator.transcript.filter.${filter}` as Key)}
                </SegmentedControlItemV2>
              )}
            </For>
          </SegmentedControlV2>
          <CheckboxV2
            label={language.t("operator.accounting.onlyNew")}
            checked={store.onlyNew}
            onChange={(on: boolean) => setStore("onlyNew", on)}
          />
          <ButtonV2
            size="small"
            variant="outline"
            onClick={(event: MouseEvent) =>
              keepInPlace(event.currentTarget as Element, () => setStore("expanded", !store.expanded))
            }
          >
            {language.t(store.expanded ? "operator.accounting.collapseAll" : "operator.accounting.expandAll")}
          </ButtonV2>
          <TextInputV2
            appearance="base"
            value={store.search}
            placeholder={language.t("operator.transcript.search")}
            aria-label={language.t("operator.transcript.search")}
            onInput={(event) => setStore("search", event.currentTarget.value)}
          />
          <ButtonV2 size="small" variant="outline" onClick={() => void download("md")}>
            {language.t("operator.transcript.exportMd")}
          </ButtonV2>
          <ButtonV2 size="small" variant="outline" onClick={() => void download("json")}>
            {language.t("operator.transcript.exportJson")}
          </ButtonV2>
          <ButtonV2
            size="small"
            variant="ghost"
            title={language.t("operator.accounting.recountHint")}
            onClick={() => void recount()}
          >
            {language.t("operator.accounting.recount")}
          </ButtonV2>
        </div>
        <p data-slot="operator-note" data-testid="transcript-counting">
          {ready(tokenizers)?.tokenizers?.length
            ? language.t("operator.accounting.countingWith", {
                names: ready(tokenizers)!
                  .tokenizers.map((item) => item.label)
                  .join(", "),
              })
            : language.t("operator.accounting.countingEstimates", { folder: ready(tokenizers)?.folder ?? "" })}{" "}
          {language.t("operator.transcript.template")}
        </p>
      </header>

      <Show when={list.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(list.error)}
        </pre>
      </Show>
      <Show when={data() && !data()!.calls.length}>
        <p data-slot="operator-note" data-testid="transcript-empty">
          {language.t("operator.transcript.noCalls")}{" "}
          <button type="button" data-slot="operator-link" onClick={() => view.set("detailed")}>
            {language.t("operator.transcript.openDetailed")}
          </button>
        </p>
      </Show>

      <div data-slot="operator-transcript-body">
        <nav data-slot="operator-transcript-jump" aria-label={language.t("operator.transcript.calls")}>
          <For each={calls()}>
            {(call) => (
              <button
                type="button"
                data-active={view.call() === call.callID ? "" : undefined}
                data-error={call.failed ? "" : undefined}
                onClick={() => view.select(call.callID)}
              >
                {language.t("operator.transcript.callShort", { index: call.index })} · {kindText(language, call)}
              </button>
            )}
          </For>
        </nav>
        <div data-slot="operator-transcript-calls" ref={content}>
          <For each={data()?.turns ?? []}>
            {(turn) => (
              <Show when={!filtering() || callsOf(turn).length}>
                <section data-slot="operator-transcript-turn" data-testid="transcript-turn">
                  <TurnHeader
                    turn={turn}
                    time={exchangeTime(turn.index)}
                    open={!store.folded[turn.index]}
                    onToggle={(control) =>
                      keepInPlace(control, () => setStore("folded", turn.index, !store.folded[turn.index]))
                    }
                  />
                  <Show when={!store.folded[turn.index]}>
                    <For each={unrecordedOf(turn)}>{(step) => <UnrecordedRow step={step} />}</For>
                    <For each={callsOf(turn)}>
                      {(call) => (
                        <>
                          <Show when={call.kind === "compaction"}>
                            <div data-slot="operator-transcript-divider">
                              {language.t("operator.transcript.compacted")}
                            </div>
                          </Show>
                          <CallCard
                            call={call}
                            sessionID={props.sessionID}
                            directory={directory()}
                            focused={view.call() === call.callID}
                            expanded={store.expanded}
                            onlyNew={store.onlyNew}
                            subagents={data()?.session.subagents ?? []}
                          />
                        </>
                      )}
                    </For>
                  </Show>
                </section>
              </Show>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}

// One model call: its header line, what it sent, what came back, and the exact request and response.
function CallCard(props: {
  call: OperatorCallSummary
  sessionID: string
  directory: string | undefined
  focused: boolean
  expanded: boolean
  onlyNew: boolean
  subagents: OperatorCallList["session"]["subagents"]
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const [visible, setVisible] = createSignal(false)
  let element: HTMLElement | undefined
  onMount(() => {
    // The call's details load once it scrolls into view.
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    })
    if (element) observer.observe(element)
    onCleanup(() => observer.disconnect())
  })
  const detail = useQuery(() => ({
    // Refreshed by the call's update event (TranscriptView), so its key does not change as it completes.
    queryKey: api.key("call", props.sessionID, props.call.callID),
    enabled: (visible() || props.focused || props.expanded) && !!props.directory,
    queryFn: () =>
      api
        .client()
        .operator.call.get({ sessionID: props.sessionID, callID: props.call.callID, directory: props.directory })
        .then((result) => result.data!),
    placeholderData: keepPreviousData,
  }))
  const [raw, setRaw] = createStore({ request: false, response: false })
  // The agent's Tool Prompt tab, from a call's tools item.
  const toolPrompt = (detail: OperatorCallDetail) =>
    detail.agent && props.directory
      ? `/operator/agents?agent=${encodeURIComponent(detail.agent)}&adir=${encodeURIComponent(props.directory)}&atab=tools`
      : undefined

  return (
    <article
      ref={element}
      data-component="operator-call"
      data-call-id={props.call.callID}
      data-kind={props.call.kind}
      data-focused={props.focused ? "" : undefined}
      data-testid="transcript-call"
    >
      <header data-slot="operator-call-head">
        <CallHeader call={props.call} />
      </header>
      <Suspense fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
        <Show
          when={ready(detail)}
          fallback={
            <p data-slot="operator-note" data-slot-loading="">
              {detail.error
                ? requestError(detail.error)
                : `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}
            </p>
          }
        >
          {(data) => (
            <>
              <Show when={data().accounting}>{(accounting) => <AccountingTable accounting={accounting()} />}</Show>
              <section data-slot="operator-call-section" data-testid="call-sent">
                <h4>{language.t("operator.accounting.sentDetail")}</h4>
                <Show when={data().accounting}>
                  {(accounting) => (
                    <SentDetail
                      accounting={accounting()}
                      onlyNew={props.onlyNew}
                      expanded={props.expanded}
                      toolPrompt={toolPrompt(data())}
                      subagents={props.subagents}
                    />
                  )}
                </Show>
                <Show when={Object.keys(data().parameters).length}>
                  <dl data-slot="operator-call-parameters">
                    <For each={Object.entries(data().parameters)}>
                      {([key, value]) => (
                        <>
                          <dt>{key}</dt>
                          <dd>
                            <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
                          </dd>
                        </>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>
              <section data-slot="operator-call-section" data-testid="call-received">
                <h4>
                  {props.call.receiving
                    ? language.t("operator.transcript.receiving")
                    : language.t("operator.transcript.received")}
                </h4>
                <ReceivedPart detail={data()} />
              </section>
              <Show when={data().accounting}>{(accounting) => <ChangesPart accounting={accounting()} />}</Show>
              <div data-slot="operator-call-raw">
                <ButtonV2
                  size="small"
                  variant="ghost"
                  onClick={(event: MouseEvent) =>
                    keepInPlace(event.currentTarget as Element, () => setRaw("request", !raw.request))
                  }
                >
                  {language.t("operator.transcript.rawRequest")}
                </ButtonV2>
                <ButtonV2
                  size="small"
                  variant="ghost"
                  onClick={(event: MouseEvent) =>
                    keepInPlace(event.currentTarget as Element, () => setRaw("response", !raw.response))
                  }
                >
                  {language.t("operator.transcript.rawResponse")}
                </ButtonV2>
              </div>
              <Show when={raw.request}>
                <RawPart
                  sessionID={props.sessionID}
                  callID={props.call.callID}
                  directory={props.directory}
                  part="request"
                />
              </Show>
              <Show when={raw.response}>
                <RawPart
                  sessionID={props.sessionID}
                  callID={props.call.callID}
                  directory={props.directory}
                  part="response"
                />
              </Show>
            </>
          )}
        </Show>
      </Suspense>
    </article>
  )
}

function CallHeader(props: { call: OperatorCallSummary }) {
  const language = useLanguage()
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
  const usage = () => props.call.usage
  const parts = () => {
    const call = props.call
    const out = [language.t("operator.transcript.callShort", { index: call.index })]
    if (call.agent) out.push(call.agent)
    if (call.model) out.push(call.model)
    out.push(clock(language, call.startedAt))
    if (call.finishedAt)
      out.push(
        call.firstByteAt
          ? language.t("operator.transcript.duration", {
              total: seconds(call.finishedAt - call.startedAt),
              first: seconds(call.firstByteAt - call.startedAt),
            })
          : seconds(call.finishedAt - call.startedAt),
      )
    // Billed: input with the cache, output with reasoning (the call's accounting), else as reported.
    const b = call.billing
    const u = usage()
    const input = b?.input ?? u?.input
    const read = b?.cacheRead ?? u?.cacheRead
    if (input !== undefined)
      out.push(
        read
          ? language.t("operator.transcript.inCache", { input: number(input), cache: number(read) })
          : language.t("operator.transcript.in", { input: number(input) }),
      )
    const output = b?.output ?? u?.output
    if (output !== undefined) out.push(language.t("operator.transcript.out", { output: number(output) }))
    const reasoning = b?.reasoning ?? u?.reasoning
    if (reasoning) out.push(language.t("operator.transcript.reasoningTokens", { count: number(reasoning) }))
    const cost = b?.opencode ?? call.cost ?? b?.provider ?? u?.cost
    if (cost !== undefined) out.push(`$${cost.toFixed(4)}`)
    if (b?.generationId) out.push(b.generationId)
    return out
  }
  return (
    <span class="inline-flex items-center gap-2 flex-wrap" data-testid="call-header">
      <Tag variant={props.call.kind === "agent" ? "accent" : "neutral"}>{kindText(language, props.call)}</Tag>
      <Show when={props.call.attempts > 1}>
        <Tag data-warning={props.call.failed ? "" : undefined}>
          {language.t("operator.transcript.attempt", { attempt: props.call.attempt, attempts: props.call.attempts })}
        </Tag>
      </Show>
      <Show when={props.call.error}>
        {(error) => (
          <Tag data-warning="">
            {language.t("operator.transcript.error", { status: String(error().status ?? props.call.httpStatus ?? "") })}
          </Tag>
        )}
      </Show>
      <Show when={props.call.receiving}>
        <Tag>{language.t("operator.transcript.receivingTag")}</Tag>
      </Show>
      <span>{parts().join(" · ")}</span>
    </span>
  )
}

function ToolCallView(props: { name: string; id?: string; args: string }) {
  const language = useLanguage()
  const [raw, setRaw] = createSignal(false)
  return (
    <div data-slot="operator-call-tool-call">
      <span class="inline-flex items-center gap-1">
        <Tag>{language.t("operator.transcript.toolCall")}</Tag>
        <code>{props.name}</code>
        <Show when={props.id}>
          <span data-slot="operator-note">{props.id}</span>
        </Show>
        <button type="button" data-slot="operator-link" onClick={() => setRaw(!raw())}>
          {language.t(raw() ? "operator.transcript.pretty" : "operator.transcript.rawString")}
        </button>
      </span>
      <pre data-component="operator-code">{raw() ? props.args : prettyArgs(props.args)}</pre>
    </div>
  )
}

// What came back, in the order it streamed: reasoning, text and tool calls, then the finish reason;
// for an error, its status and body.
function ReceivedPart(props: { detail: OperatorCallDetail }) {
  const language = useLanguage()
  return (
    <div data-slot="operator-call-part">
      <Show when={props.detail.error}>
        {(error) => (
          <pre data-slot="operator-error">
            {[error().status ? `HTTP ${error().status}` : "", error().message ?? "", error().body ?? ""]
              .filter(Boolean)
              .join("\n")}
          </pre>
        )}
      </Show>
      <Show when={props.detail.received}>
        {(received) => (
          <>
            <Show when={!received().parsed && received().raw}>
              <pre data-component="operator-code">{received().raw}</pre>
            </Show>
            <For each={received().blocks}>
              {(block) => (
                <Switch>
                  <Match when={block.type === "reasoning"}>
                    <details open data-slot="operator-call-reasoning" data-testid="call-reasoning">
                      <summary>
                        {props.detail.usage?.reasoning
                          ? language.t("operator.transcript.reasoningCount", {
                              count: new Intl.NumberFormat(language.intl()).format(props.detail.usage.reasoning),
                            })
                          : language.t("operator.transcript.reasoning")}
                      </summary>
                      <Show
                        when={!block.encrypted}
                        fallback={<p data-slot="operator-note">{language.t("operator.transcript.encrypted")}</p>}
                      >
                        <pre data-component="operator-code">{block.text}</pre>
                      </Show>
                    </details>
                  </Match>
                  <Match when={block.type === "text"}>
                    <pre data-component="operator-code" data-slot="operator-call-text">
                      {block.text}
                    </pre>
                  </Match>
                  <Match when={block.type === "tool-call"}>
                    <ToolCallView name={block.name ?? ""} id={block.id} args={block.arguments ?? ""} />
                  </Match>
                </Switch>
              )}
            </For>
            <Show when={received().finish}>
              {(finish) => (
                <p data-slot="operator-note">{language.t("operator.transcript.finish", { reason: finish() })}</p>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={props.detail.warnings.length}>
        <p data-slot="operator-note" data-warning="">
          {props.detail.warnings
            .map((warning) => language.t(`operator.transcript.warning.${warning}` as Key))
            .join(" ")}
        </p>
      </Show>
    </div>
  )
}

// The exact request body (rebuilt byte for byte), or the assembled response, with Copy.
function RawPart(props: {
  sessionID: string
  callID: string
  directory: string | undefined
  part: "request" | "response"
}) {
  const language = useLanguage()
  const api = useOperatorClient()
  const raw = useQuery(() => ({
    queryKey: api.key("call-raw", props.sessionID, props.callID, props.part),
    queryFn: () =>
      api
        .client()
        .operator.call.raw({
          sessionID: props.sessionID,
          callID: props.callID,
          directory: props.directory,
          part: props.part,
        })
        .then((result) => result.data!),
  }))
  const pretty = createMemo(() => {
    const text = ready(raw)?.text ?? ""
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  })
  return (
    <div data-slot="operator-call-part" data-testid={`call-raw-${props.part}`}>
      <Show when={ready(raw)} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
        {(data) => (
          <>
            <div class="flex items-center gap-2">
              <span data-slot="operator-note">
                {language.t(
                  props.part === "request"
                    ? "operator.transcript.rawRequestSize"
                    : "operator.transcript.rawResponseSize",
                  {
                    bytes: new Intl.NumberFormat(language.intl()).format(data().bytes),
                  },
                )}
              </span>
              <ButtonV2
                size="small"
                variant="outline"
                onClick={() =>
                  void navigator.clipboard.writeText(data().text).then(() =>
                    showToast({
                      variant: "success",
                      icon: "circle-check",
                      title: language.t("operator.toolPrompt.copied"),
                    }),
                  )
                }
              >
                {language.t("operator.toolPrompt.copy")}
              </ButtonV2>
            </div>
            <pre data-component="operator-code">{pretty()}</pre>
          </>
        )}
      </Show>
    </div>
  )
}

function kindText(language: Language, call: OperatorCallSummary) {
  if (call.kind === "agent")
    return call.step !== undefined
      ? language.t("operator.transcript.kind.step", { step: call.step })
      : language.t("operator.transcript.kind.agent")
  return language.t(`operator.transcript.kind.${call.kind}` as Key)
}

function clock(language: Language, time: number) {
  return new Intl.DateTimeFormat(language.intl(), { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(
    new Date(time),
  )
}
