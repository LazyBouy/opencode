import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import type {
  OperatorCallDetail,
  OperatorCallExchange,
  OperatorCallMessage,
  OperatorCallSummary,
} from "@opencode-ai/sdk/v2/client"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
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
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { useOperatorClient } from "../data"
import { requestError } from "../pages/config-helpers"
import { lineDiff, type Piece, pieces, prettyArgs, runs } from "./content"
import { useOpenSessionView, useSessionView } from "./view"
import "./session-views.css"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]
type Language = ReturnType<typeof useLanguage>
type Filter = "all" | "agent" | "title" | "compaction" | "summary" | "errors"
const FILTERS: Filter[] = ["all", "agent", "title", "compaction", "summary", "errors"]

// The Transcript view: every model call of the session, in order, grouped by the user message it
// answers, each exactly as sent (formatted for reading; earlier messages folded) and as received, with
// the exact request body and the response a click away. Read-only; it follows a running session.
export function TranscriptView(props: { sessionID: string }) {
  const language = useLanguage()
  const api = useOperatorClient()
  const serverSdk = useServerSDK()
  const queryClient = useQueryClient()
  const view = useSessionView()
  const [store, setStore] = createStore({ filter: "all" as Filter, search: "" })
  const session = useQuery(() => ({
    queryKey: api.key("session", props.sessionID),
    queryFn: () =>
      api
        .client()
        .session.get({ sessionID: props.sessionID })
        .then((result) => result.data!),
  }))
  const directory = () => session.data?.directory
  const list = useQuery(() => ({
    queryKey: api.key("calls", props.sessionID),
    enabled: !!directory(),
    queryFn: () =>
      api
        .client()
        .operator.call.list({ sessionID: props.sessionID, directory: directory() })
        .then((result) => result.data!),
  }))

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
  }))
  const matches = (call: OperatorCallSummary) => {
    if (store.filter === "errors") return !!call.error || !!call.retryOf
    if (store.filter !== "all" && call.kind !== store.filter) return false
    const search = store.search.trim().toLowerCase()
    if (!search) return true
    if (searched.data?.has(call.callID)) return true
    const exchange = list.data?.exchanges.find((item) => item.index === call.exchange)
    return [call.model, call.agent, call.kind, exchange?.text]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(search))
  }
  const calls = createMemo(() => (list.data?.calls ?? []).filter(matches))
  // The transcript in order: exchange headers (with the calls that answer them), and side calls where
  // they happened.
  const items = createMemo(() => {
    const out: Array<{ exchange: OperatorCallExchange } | { call: OperatorCallSummary }> = []
    const exchanges = list.data?.exchanges ?? []
    let next = 0
    for (const call of calls()) {
      while (next < exchanges.length && (call.exchange ?? 0) >= exchanges[next]!.index) {
        out.push({ exchange: exchanges[next]! })
        next++
      }
      out.push({ call })
    }
    if (store.filter === "all" && !store.search.trim())
      for (; next < exchanges.length; next++) out.push({ exchange: exchanges[next]! })
    return out
  })
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)

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

  // A link to one call (`?call=`) scrolls to it once it is listed.
  createEffect(() => {
    const id = view.call()
    if (!id || !calls().some((call) => call.callID === id)) return
    requestAnimationFrame(() =>
      document.querySelector(`[data-call-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" }),
    )
  })

  return (
    <div data-component="operator-transcript" data-testid="transcript">
      <header data-slot="operator-transcript-head">
        <Show when={list.data}>
          {(data) => (
            <p data-slot="operator-note" data-testid="transcript-totals">
              {language.t("operator.transcript.totals", {
                calls: data().totals.calls,
                input: number(data().totals.input),
                output: number(data().totals.output),
                reasoning: number(data().totals.reasoning),
                cache: number(data().totals.cacheRead),
                cost: `$${data().totals.cost.toFixed(4)}`,
              })}
            </p>
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
        </div>
        <p data-slot="operator-note">{language.t("operator.transcript.template")}</p>
      </header>

      <Show when={list.error}>
        <pre data-slot="operator-error" role="alert">
          {requestError(list.error)}
        </pre>
      </Show>
      <Show when={list.data && !list.data.calls.length}>
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
                data-error={call.error ? "" : undefined}
                onClick={() => view.set("transcript", call.callID)}
              >
                {language.t("operator.transcript.callShort", { index: call.index })} · {kindText(language, call)}
              </button>
            )}
          </For>
        </nav>
        <div data-slot="operator-transcript-calls">
          <For each={items()}>
            {(item) =>
              "exchange" in item ? (
                <ExchangeHeader exchange={item.exchange} onDetailed={() => view.set("detailed")} />
              ) : (
                <>
                  <Show when={item.call.kind === "compaction"}>
                    <div data-slot="operator-transcript-divider">{language.t("operator.transcript.compacted")}</div>
                  </Show>
                  <CallCard
                    call={item.call}
                    sessionID={props.sessionID}
                    directory={directory()}
                    focused={view.call() === item.call.callID}
                    agentDirectory={directory()}
                  />
                </>
              )
            }
          </For>
        </div>
      </div>
    </div>
  )
}

function ExchangeHeader(props: { exchange: OperatorCallExchange; onDetailed: () => void }) {
  const language = useLanguage()
  return (
    <div data-slot="operator-transcript-exchange" data-testid="transcript-exchange">
      <strong>{language.t("operator.transcript.you")}</strong>
      <span data-slot="operator-note">{clock(language, props.exchange.time)}</span>
      <span data-slot="operator-transcript-exchange-text">{props.exchange.text}</span>
      <Show when={!props.exchange.recorded}>
        <span data-slot="operator-note">
          {language.t("operator.transcript.notRecorded")}{" "}
          <button type="button" data-slot="operator-link" onClick={props.onDetailed}>
            {language.t("operator.transcript.openDetailed")}
          </button>
        </span>
      </Show>
    </div>
  )
}

// One model call: its header line, what it sent, what came back, and the exact request and response.
function CallCard(props: {
  call: OperatorCallSummary
  sessionID: string
  directory: string | undefined
  focused: boolean
  agentDirectory: string | undefined
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
    queryKey: api.key("call", props.sessionID, props.call.callID, props.call.receiving),
    enabled: (visible() || props.focused) && !!props.directory,
    queryFn: () =>
      api
        .client()
        .operator.call.get({ sessionID: props.sessionID, callID: props.call.callID, directory: props.directory })
        .then((result) => result.data!),
  }))
  const [raw, setRaw] = createStore({ request: false, response: false })

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
      <Show
        when={detail.data}
        fallback={
          <p data-slot="operator-note">
            {detail.error
              ? requestError(detail.error)
              : `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`}
          </p>
        }
      >
        {(data) => (
          <>
            <section data-slot="operator-call-section" data-testid="call-sent">
              <h4>{language.t("operator.transcript.sent")}</h4>
              <SystemPart detail={data()} />
              <ToolsPart detail={data()} directory={props.agentDirectory} />
              <MessagesPart messages={data().sent} />
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
            <div data-slot="operator-call-raw">
              <ButtonV2 size="small" variant="ghost" onClick={() => setRaw("request", !raw.request)}>
                {language.t("operator.transcript.rawRequest")}
              </ButtonV2>
              <ButtonV2 size="small" variant="ghost" onClick={() => setRaw("response", !raw.response)}>
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
    const u = usage()
    if (u?.input !== undefined)
      out.push(
        u.cacheRead
          ? language.t("operator.transcript.inCache", { input: number(u.input), cache: number(u.cacheRead) })
          : language.t("operator.transcript.in", { input: number(u.input) }),
      )
    if (u?.output !== undefined) out.push(language.t("operator.transcript.out", { output: number(u.output) }))
    if (u?.reasoning) out.push(language.t("operator.transcript.reasoningTokens", { count: number(u.reasoning) }))
    const cost = call.cost ?? u?.cost
    if (cost !== undefined) out.push(`$${cost.toFixed(4)}`)
    return out
  }
  return (
    <span class="inline-flex items-center gap-2 flex-wrap" data-testid="call-header">
      <Tag variant={props.call.kind === "agent" ? "accent" : "neutral"}>{kindText(language, props.call)}</Tag>
      <Show when={props.call.retryOf}>
        {(retry) => (
          <Tag data-warning="">
            {language.t("operator.transcript.retry", { attempt: retry().attempt, index: retry().index })}
          </Tag>
        )}
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

// The system text: in full the first time; later "same as call N", or what changed since.
function SystemPart(props: { detail: OperatorCallDetail }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  return (
    <Show when={props.detail.system.chars}>
      <div data-slot="operator-call-part" data-testid="call-system">
        <Switch
          fallback={
            <details open>
              <summary>
                {language.t("operator.transcript.system", { chars: number(props.detail.system.chars) })}
              </summary>
              <pre data-component="operator-code">{props.detail.systemText}</pre>
            </details>
          }
        >
          <Match when={props.detail.previousSystem}>
            {(previous) => (
              <details>
                <summary data-warning="">
                  {language.t("operator.transcript.systemChanged", { index: previous().index })}
                </summary>
                <pre data-component="operator-code" data-slot="operator-text-diff">
                  <For each={lineDiff(previous().text, props.detail.systemText ?? "")}>
                    {(line) => (
                      <span data-change={line.change}>{`${line.change === "added" ? "+" : "−"} ${line.text}\n`}</span>
                    )}
                  </For>
                </pre>
              </details>
            )}
          </Match>
          <Match when={props.detail.system.sameAs}>
            {(index) => (
              <div>
                <span data-slot="operator-note">
                  {language.t("operator.transcript.systemSame", {
                    index: index(),
                    chars: number(props.detail.system.chars),
                  })}
                </span>{" "}
                <button type="button" data-slot="operator-link" onClick={() => setOpen(!open())}>
                  {language.t(open() ? "operator.transcript.collapse" : "operator.transcript.expand")}
                </button>
                <Show when={open()}>
                  <pre data-component="operator-code">{props.detail.systemText}</pre>
                </Show>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

// The tools: "11 tools, same as call 6", or what changed, with the names and the value as sent.
function ToolsPart(props: { detail: OperatorCallDetail; directory: string | undefined }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const toolPrompt = () =>
    props.detail.agent && props.directory
      ? `/operator/agents?agent=${encodeURIComponent(props.detail.agent)}&adir=${encodeURIComponent(props.directory)}&atab=tools`
      : undefined
  return (
    <Show when={props.detail.tools.count}>
      <div data-slot="operator-call-part" data-testid="call-tools">
        <span data-slot="operator-note">
          {props.detail.tools.sameAs !== undefined
            ? language.t("operator.transcript.toolsSame", {
                count: props.detail.tools.count,
                index: props.detail.tools.sameAs,
              })
            : language.t("operator.transcript.tools", { count: props.detail.tools.count })}
        </span>{" "}
        <button type="button" data-slot="operator-link" onClick={() => setOpen(!open())}>
          {language.t(open() ? "operator.transcript.collapse" : "operator.transcript.expand")}
        </button>{" "}
        <Show when={toolPrompt()}>
          {(href) => (
            <a data-slot="operator-link" href={href()}>
              {language.t("operator.transcript.toolPrompt")}
            </a>
          )}
        </Show>
        <Show when={props.detail.toolsDiff}>
          {(diff) => (
            <p data-slot="operator-note" data-warning="">
              {language.t("operator.transcript.toolsChanged", {
                index: diff().index,
                added: diff().added.join(", ") || "—",
                removed: diff().removed.join(", ") || "—",
                changed: diff().changed.join(", ") || "—",
              })}
            </p>
          )}
        </Show>
        <Show when={open()}>
          <p data-slot="operator-note">{props.detail.toolNames.join(", ")}</p>
          <pre data-component="operator-code">{JSON.stringify(props.detail.toolsValue, null, 2)}</pre>
        </Show>
      </div>
    </Show>
  )
}

// The messages: those earlier calls sent fold into "Messages 1–14: same as call 6"; new ones in full.
function MessagesPart(props: { messages: ReadonlyArray<OperatorCallMessage> }) {
  const language = useLanguage()
  const [shown, setShown] = createStore<Record<number, boolean>>({})
  return (
    <div data-slot="operator-call-part" data-testid="call-messages">
      <For each={runs(props.messages)}>
        {(item) =>
          "seen" in item ? (
            <div data-slot="operator-call-seen">
              <span data-slot="operator-note">
                {item.seen.from === item.seen.to
                  ? language.t("operator.transcript.seenOne", { index: item.seen.from, call: item.seen.call })
                  : language.t("operator.transcript.seen", {
                      from: item.seen.from,
                      to: item.seen.to,
                      call: item.seen.call,
                    })}
              </span>{" "}
              <button
                type="button"
                data-slot="operator-link"
                onClick={() => setShown(item.seen.from, !shown[item.seen.from])}
              >
                {language.t(shown[item.seen.from] ? "operator.transcript.collapse" : "operator.transcript.expand")}
              </button>
              <Show when={shown[item.seen.from]}>
                <For each={props.messages.filter((m) => m.index >= item.seen.from && m.index <= item.seen.to)}>
                  {(message) => <MessageView message={message} />}
                </For>
              </Show>
            </div>
          ) : (
            <MessageView message={item.message} />
          )
        }
      </For>
    </div>
  )
}

function MessageView(props: { message: OperatorCallMessage }) {
  const language = useLanguage()
  return (
    <div data-slot="operator-call-message" data-role={props.message.role} data-testid="call-message">
      <div class="flex items-center gap-1 flex-wrap">
        <strong>{props.message.role}</strong>
        <span data-slot="operator-note">#{props.message.index}</span>
        <For each={props.message.marks}>
          {(mark) => (
            <Tag data-mark={mark} data-warning={mark === "in-memory" || mark === "cleared" ? "" : undefined}>
              {language.t(`operator.transcript.mark.${mark}` as Key)}
            </Tag>
          )}
        </For>
      </div>
      <For each={pieces(props.message.content)}>{(piece) => <PieceView piece={piece} />}</For>
    </div>
  )
}

function PieceView(props: { piece: Piece }): JSX.Element {
  const language = useLanguage()
  const openView = useOpenSessionView()
  const piece = props.piece
  switch (piece.kind) {
    case "text":
      return (
        <pre data-component="operator-code" data-slot="operator-call-text">
          {piece.text}
        </pre>
      )
    case "reasoning":
      return (
        <details open data-slot="operator-call-reasoning">
          <summary>{language.t("operator.transcript.reasoning")}</summary>
          <Show
            when={!piece.encrypted}
            fallback={<p data-slot="operator-note">{language.t("operator.transcript.encrypted")}</p>}
          >
            <pre data-component="operator-code">{piece.text}</pre>
          </Show>
        </details>
      )
    case "tool-call":
      return <ToolCallView name={piece.name} id={piece.id} args={piece.args} />
    case "tool-result":
      return (
        <div data-slot="operator-call-tool-result">
          <span data-slot="operator-note">
            {language.t("operator.transcript.toolResult", { id: piece.id ?? piece.name ?? "" })}
          </span>
          <pre data-component="operator-code">{piece.text}</pre>
          <Show when={piece.subagent}>
            {(id) => (
              <button type="button" data-slot="operator-link" onClick={() => openView(id(), "transcript")}>
                {language.t("operator.transcript.subagent", { id: id() })}
              </button>
            )}
          </Show>
        </div>
      )
    case "attachment":
      return (
        <p data-slot="operator-note">
          {language.t(piece.type === "image" ? "operator.transcript.image" : "operator.transcript.file", {
            mime: piece.mime ?? "",
            size: piece.size !== undefined ? new Intl.NumberFormat(language.intl()).format(piece.size) : "?",
          })}
        </p>
      )
    case "json":
      return <pre data-component="operator-code">{JSON.stringify(piece.value, null, 2)}</pre>
  }
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
    const text = raw.data?.text ?? ""
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  })
  return (
    <div data-slot="operator-call-part" data-testid={`call-raw-${props.part}`}>
      <Show when={raw.data} fallback={<p data-slot="operator-note">{language.t("common.loading")}</p>}>
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
