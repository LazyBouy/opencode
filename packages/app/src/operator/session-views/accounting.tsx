import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type {
  OperatorCallAccounting,
  OperatorCallList,
  OperatorInputItem,
  OperatorOutputItem,
  OperatorTokenTotals,
  OperatorTurn,
  OperatorUnrecordedStep,
} from "@opencode-ai/sdk/v2/client"
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "../ui/field-help"
import { prettyArgs, subagentOf } from "./content"
import { useOpenSessionView } from "./view"

// The Transcript's token accounting (the server's operator/call-accounting.ts): the session's totals and
// where its input went, each turn's totals, and each call's accounting table, its items in detail and
// what changed since the previous call. Every billed token is in one row; nothing is folded without its
// count.

type Language = ReturnType<typeof useLanguage>
type Key = Parameters<Language["t"]>[0]

export function useNumbers() {
  const language = useLanguage()
  const format = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  return {
    n: format,
    // Small amounts keep their digits; nothing is $0.
    money: (value: number | undefined) =>
      value === undefined
        ? "—"
        : value === 0
          ? "$0"
          : `$${Math.abs(value) < 0.01 ? value.toFixed(6) : value.toFixed(4)}`,
    share: (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—"),
  }
}

// An input item's label, as the spec names it.
export function itemLabel(language: Language, item: OperatorInputItem): string {
  const from = item.call !== undefined ? ` ${language.t("operator.accounting.fromCall", { call: item.call })}` : ""
  switch (item.kind) {
    case "system":
      return language.t("operator.accounting.item.system")
    case "tools":
      return language.t("operator.accounting.item.tools", { count: item.name ?? "?" })
    case "user":
      return `${language.t("operator.accounting.item.user", { text: item.preview ?? "" })}${item.turn !== undefined ? ` ${language.t("operator.accounting.turnOf", { turn: item.turn })}` : ""}`
    case "added-saved":
      return language.t("operator.accounting.item.addedSaved")
    case "added-request":
      return language.t("operator.accounting.item.addedRequest", {
        what: language.t(`operator.accounting.inMemory.${item.name ?? "reminder.plan"}` as Key),
      })
    case "attachment":
      return language.t(
        item.attachment?.type === "image" ? "operator.accounting.item.image" : "operator.accounting.item.file",
        { mime: item.attachment?.mime ?? "" },
      )
    case "summary":
      return language.t("operator.accounting.item.summary", { from: item.turns?.from ?? 1, to: item.turns?.to ?? "?" })
    case "assistant":
      return `${language.t("operator.accounting.item.assistant", { text: item.preview ?? "" })}${from}`
    case "reasoning-sent":
      return `${language.t("operator.accounting.item.reasoningSent")}${from}`
    case "tool-call":
      return `${language.t("operator.accounting.item.toolCall", { name: item.name ?? "?" })}${from}`
    case "tool-result":
      return language.t("operator.accounting.item.toolResult", { name: item.name ?? "?" })
    case "parameters":
      return language.t("operator.accounting.item.parameters")
    case "unrecognized":
      return language.t("operator.accounting.item.unrecognized", { chars: item.chars })
  }
}

export function outputLabel(language: Language, item: OperatorOutputItem, n: (value: number) => string): string {
  switch (item.kind) {
    case "reasoning":
      return language.t("operator.accounting.output.reasoning")
    case "reasoning-summary":
      return language.t("operator.accounting.output.reasoningSummary")
    case "reasoning-hidden":
      return language.t("operator.accounting.output.reasoningHidden", { count: n(item.tokens) })
    case "reasoning-encrypted":
      return language.t("operator.accounting.output.reasoningEncrypted", { count: n(item.tokens) })
    case "text":
      return language.t("operator.accounting.output.text")
    case "tool-call":
      return language.t("operator.accounting.output.toolCall", { name: item.name ?? "?" })
  }
}

function Flags(props: { item: OperatorInputItem }) {
  const language = useLanguage()
  return (
    <For each={props.item.flags}>
      {(flag) => (
        <Tag data-warning={flag === "cleared" || flag === "shortened" ? "" : undefined}>
          {language.t(`operator.accounting.flag.${flag}` as Key)}
        </Tag>
      )}
    </For>
  )
}

const methodKey = (method: string, output?: boolean): Key =>
  (output && method === "reported"
    ? "operator.accounting.method.reportedOutput"
    : `operator.accounting.method.${method}`) as Key

// ---- The session ----

export function SessionTotalsView(props: { list: OperatorCallList }) {
  const language = useLanguage()
  const { n, money } = useNumbers()
  const label = (id: string) =>
    id === "subagents"
      ? language.t("operator.accounting.row.subagents", { count: props.list.session.subagents.length })
      : language.t(`operator.accounting.row.${id}` as Key)
  const session = () => props.list.session.rows.find((row) => row.id === "session")?.totals
  return (
    <div data-slot="operator-accounting-session" data-testid="transcript-totals">
      <table data-component="operator-accounting" aria-label={language.t("operator.accounting.sessionTable")}>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.calls")}
            </th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.inputNew")}
            </th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.cacheRead")}
            </th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.cacheWrite")}
            </th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.output")}
            </th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.reasoning")}
            </th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.cost")}
              <FieldHelp
                field={language.t("operator.accounting.column.cost")}
                text={language.t("operator.help.accountingCost")}
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <For each={props.list.session.rows}>
            {(row) => (
              <tr data-row={row.id} data-total={row.id === "session" || row.id === "all" ? "" : undefined}>
                <th scope="row">{label(row.id)}</th>
                <td data-align="end">{n(row.totals.calls)}</td>
                <td data-align="end">{n(row.totals.new)}</td>
                <td data-align="end">{n(row.totals.cacheRead)}</td>
                <td data-align="end">{n(row.totals.cacheWrite)}</td>
                <td data-align="end">{n(row.totals.output)}</td>
                <td data-align="end">{n(row.totals.reasoning)}</td>
                <td data-align="end">{money(row.totals.cost)}</td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <Show when={session()}>
        {(totals) => (
          <p data-slot="operator-note" data-testid="transcript-billed">
            {language.t("operator.accounting.billedTotals", {
              calls: props.list.totals.calls,
              // No call with a provider cost: none was billed by one that reports it.
              provider: props.list.calls.some((call) => call.billing?.provider !== undefined)
                ? money(totals().providerCost)
                : "—",
              opencode: money(totals().cost),
            })}
            <Show when={props.list.session.providerMissing.length}>
              {" "}
              {language.t("operator.accounting.providerMissing", {
                calls: props.list.session.providerMissing.join(", "),
              })}
            </Show>
            <Show when={props.list.session.uncertain}>
              {" "}
              <Tag data-warning="">
                {language.t("operator.accounting.uncertainCalls", { count: props.list.session.uncertain })}
              </Tag>
            </Show>
          </p>
        )}
      </Show>
    </div>
  )
}

// "Where the input tokens went": a stacked bar and a table, over every recorded call.
export function InputBreakdown(props: { list: OperatorCallList }) {
  const language = useLanguage()
  const { n, share } = useNumbers()
  const parts = () => props.list.session.inputBy.filter((item) => item.tokens !== 0)
  const whole = () => parts().reduce((total, item) => total + Math.max(0, item.tokens), 0)
  return (
    <Show when={whole() > 0}>
      <details data-slot="operator-accounting-breakdown" data-testid="transcript-input-by" open>
        <summary>{language.t("operator.accounting.inputBy")}</summary>
        <div data-slot="operator-accounting-bar" role="img" aria-label={language.t("operator.accounting.inputBy")}>
          <For each={parts().filter((item) => item.tokens > 0)}>
            {(item) => (
              <span
                data-group={item.group}
                style={{ width: `${(item.tokens / whole()) * 100}%` }}
                title={`${language.t(`operator.accounting.group.${item.group}` as Key)}: ${n(item.tokens)}`}
              />
            )}
          </For>
        </div>
        <table data-component="operator-accounting">
          <thead>
            <tr>
              <th scope="col">{language.t("operator.accounting.column.part")}</th>
              <th scope="col" data-align="end">
                {language.t("operator.accounting.column.tokens")}
              </th>
              <th scope="col" data-align="end">
                {language.t("operator.accounting.column.share")}
              </th>
              <th scope="col" data-align="end">
                {language.t("operator.accounting.column.cacheRead")}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={parts()}>
              {(item) => (
                <tr>
                  <th scope="row">
                    <span data-slot="operator-accounting-swatch" data-group={item.group} />
                    {language.t(`operator.accounting.group.${item.group}` as Key)}
                  </th>
                  <td data-align="end">{n(item.tokens)}</td>
                  <td data-align="end">{share(item.tokens, whole())}</td>
                  <td data-align="end">{n(item.cacheRead)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </details>
    </Show>
  )
}

// ---- Turns ----

export function totalsLine(language: Language, totals: OperatorTokenTotals, numbers: ReturnType<typeof useNumbers>) {
  return language.t("operator.accounting.totalsLine", {
    calls:
      totals.calls === 1
        ? language.t("operator.accounting.oneCall")
        : language.t("operator.accounting.calls", { count: numbers.n(totals.calls) }),
    ...tokensOf(totals, numbers),
  })
}

function tokensOf(totals: OperatorTokenTotals, numbers: ReturnType<typeof useNumbers>) {
  return {
    input: numbers.n(totals.input),
    read: numbers.n(totals.cacheRead),
    fresh: numbers.n(totals.new),
    output: numbers.n(totals.output),
    reasoning: numbers.n(totals.reasoning),
    cost: numbers.money(totals.cost),
  }
}

export function TurnHeader(props: { turn: OperatorTurn; open: boolean; onToggle: () => void; time?: number }) {
  const language = useLanguage()
  const numbers = useNumbers()
  return (
    <button
      type="button"
      data-slot="operator-transcript-exchange"
      data-testid="transcript-exchange"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      <strong>
        {props.turn.index
          ? language.t("operator.accounting.turn", { index: props.turn.index })
          : language.t("operator.accounting.turnOther")}
      </strong>
      <Show when={props.turn.index}>
        <span data-slot="operator-transcript-exchange-text">
          {language.t("operator.accounting.item.user", { text: props.turn.text })}
        </span>
      </Show>
      <span data-slot="operator-note">{totalsLine(language, props.turn.totals, numbers)}</span>
    </button>
  )
}

export function UnrecordedRow(props: { step: OperatorUnrecordedStep }) {
  const language = useLanguage()
  const numbers = useNumbers()
  return (
    <div data-slot="operator-transcript-unrecorded" data-testid="transcript-unrecorded">
      <Tag>{language.t("operator.accounting.unrecordedTag")}</Tag>
      <span data-slot="operator-note">
        {language.t("operator.accounting.stepLine", tokensOf(props.step.totals, numbers))}
      </span>
      <p data-slot="operator-note">{language.t("operator.accounting.unrecorded")}</p>
    </div>
  )
}

// ---- One call ----

// The accounting table: what was sent and received, every token in one row, summing to the billed
// totals; the cache boundary drawn where it falls and the measured delta on the items it covers.
export function AccountingTable(props: { accounting: OperatorCallAccounting }) {
  const language = useLanguage()
  const { n, money } = useNumbers()
  const input = () => props.accounting.input
  const output = () => props.accounting.output
  const cost = () => props.accounting.cost
  const deltaItems = createMemo(() => new Set(input().delta?.items ?? []))
  const lastDelta = () => input().delta?.items.at(-1)
  const labelOf = (id: string) => {
    const item = input().items.find((entry) => entry.id === id)
    return item ? itemLabel(language, item) : language.t("operator.accounting.formatting")
  }
  const negative = () => (input().unattributed ?? 0) < 0
  return (
    <div data-slot="operator-call-accounting" data-testid="call-accounting">
      <table data-component="operator-accounting" aria-label={language.t("operator.accounting.callTable")}>
        <thead>
          <tr>
            <th scope="col">{language.t("operator.accounting.sent")}</th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.tokens")}
            </th>
            <th scope="col">{language.t("operator.accounting.column.how")}</th>
            <th scope="col">{language.t("operator.accounting.column.cache")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={input().items}>
            {(item) => (
              <>
                <tr
                  data-item={item.kind}
                  data-delta={deltaItems().has(item.id) ? "" : undefined}
                  data-testid="accounting-row"
                >
                  <th scope="row">
                    <span class="inline-flex items-center gap-1 flex-wrap">
                      {itemLabel(language, item)}
                      <Show when={item.since !== undefined && !deltaItems().has(item.id)}>
                        <span data-slot="operator-note">
                          {language.t("operator.accounting.sinceCall", { call: item.since! })}
                        </span>
                      </Show>
                      <Flags item={item} />
                    </span>
                  </th>
                  <td data-align="end">{n(item.tokens)}</td>
                  <td>{language.t(methodKey(item.method))}</td>
                  <td data-cache={item.cache}>
                    {item.kind === "parameters" ? "" : language.t(`operator.accounting.cache.${item.cache}` as Key)}
                  </td>
                </tr>
                <Show when={input().boundary?.item === item.id ? input().boundary : undefined}>
                  {(boundary) => (
                    <tr data-slot="operator-accounting-boundary" data-testid="accounting-boundary">
                      <td colSpan={4}>
                        {language.t("operator.accounting.boundary", {
                          read: n(input().cacheRead),
                          after: n(boundary().after),
                          item: labelOf(boundary().item),
                        })}
                      </td>
                    </tr>
                  )}
                </Show>
                <Show when={input().delta && lastDelta() === item.id ? input().delta : undefined}>
                  {(delta) => (
                    <tr data-slot="operator-accounting-delta" data-testid="accounting-delta">
                      <td colSpan={4}>
                        {language.t("operator.accounting.delta", { tokens: n(delta().tokens), call: delta().from })}
                      </td>
                    </tr>
                  )}
                </Show>
              </>
            )}
          </For>
          <Show when={input().unattributed !== undefined}>
            <tr data-item="formatting" data-testid="accounting-formatting">
              <th scope="row">
                <span class="inline-flex items-center gap-1 flex-wrap">
                  {language.t("operator.accounting.formatting")}
                  <FieldHelp
                    field={language.t("operator.accounting.formatting")}
                    text={language.t("operator.help.accountingFormatting")}
                  />
                  <Show when={negative()}>
                    <span data-slot="operator-note" data-warning="">
                      {language.t("operator.accounting.formattingNegative", {
                        count: n(-(input().unattributed ?? 0)),
                        share: `${Math.round(((input().unattributed ?? 0) / (input().billed || 1)) * 100)}%`,
                      })}
                    </span>
                  </Show>
                </span>
              </th>
              <td data-align="end">{n(input().unattributed ?? 0)}</td>
              <td />
              <td />
            </tr>
          </Show>
          <Show when={input().boundary?.item === "formatting"}>
            <tr data-slot="operator-accounting-boundary">
              <td colSpan={4}>
                {language.t("operator.accounting.boundaryFormatting", { read: n(input().cacheRead) })}
              </td>
            </tr>
          </Show>
          <Show
            when={input().billed !== undefined}
            fallback={
              <tr>
                <td colSpan={4} data-slot="operator-note">
                  {language.t("operator.accounting.notReported")}
                </td>
              </tr>
            }
          >
            <tr data-total="" data-testid="accounting-total-input">
              <th scope="row">{language.t("operator.accounting.totalBilled")}</th>
              <td data-align="end">{n(input().billed ?? 0)}</td>
              <td colSpan={2}>
                {language.t("operator.accounting.totalSplit", {
                  read: n(input().cacheRead),
                  write: n(input().cacheWrite),
                  fresh: n(input().new ?? 0),
                })}
              </td>
            </tr>
          </Show>
        </tbody>
        <thead>
          <tr>
            <th scope="col">{language.t("operator.accounting.received")}</th>
            <th scope="col" data-align="end">
              {language.t("operator.accounting.column.tokens")}
            </th>
            <th scope="col">{language.t("operator.accounting.column.how")}</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          <For each={output().items}>
            {(item) => (
              <tr data-item={item.kind}>
                <th scope="row">{outputLabel(language, item, n)}</th>
                <td data-align="end">{n(item.tokens)}</td>
                <td>
                  {language.t(methodKey(item.method, item.kind !== "reasoning" && !item.kind.startsWith("reasoning")))}
                </td>
                <td />
              </tr>
            )}
          </For>
          <Show when={output().unattributed !== undefined}>
            <tr data-item="formatting">
              <th scope="row">{language.t("operator.accounting.formatting")}</th>
              <td data-align="end">{n(output().unattributed ?? 0)}</td>
              <td />
              <td />
            </tr>
          </Show>
          <Show when={output().billed !== undefined}>
            <tr data-total="" data-testid="accounting-total-output">
              <th scope="row">{language.t("operator.accounting.totalBilled")}</th>
              <td data-align="end">{n(output().billed ?? 0)}</td>
              <td colSpan={2}>
                <Show when={output().reasoning}>
                  {language.t("operator.accounting.ofWhichReasoning", { count: n(output().reasoning) })}
                </Show>
              </td>
            </tr>
          </Show>
        </tbody>
      </table>
      <Show when={input().new !== undefined && input().delta}>
        <p data-slot="operator-note">{language.t("operator.accounting.newNote")}</p>
      </Show>
      <Show when={input().uncertain}>
        {(reason) => (
          <p data-slot="operator-note" data-warning="" data-testid="accounting-uncertain">
            {language.t(`operator.accounting.uncertain.${reason()}` as Key)}
          </p>
        )}
      </Show>
      <Show when={input().unrecognized}>
        {(chars) => (
          <p data-slot="operator-note" data-warning="">
            {language.t("operator.accounting.unrecognizedCard", { chars: n(chars()) })}
          </p>
        )}
      </Show>
      <p data-slot="operator-note" data-testid="accounting-cost">
        {language.t("operator.accounting.cost", {
          provider: money(cost().provider),
          generation: cost().generationId ? `, ${cost().generationId}` : "",
          opencode: money(cost().opencode),
        })}
        <Show when={cost().difference !== undefined}>
          {" · "}
          {language.t("operator.accounting.difference", { value: money(cost().difference) })}
        </Show>
        <Show when={cost().split}>
          {(split) => (
            <>
              {" · "}
              {language.t("operator.accounting.split", {
                input: money(split().input),
                read: money(split().cacheRead),
                write: money(split().cacheWrite),
                output: money(split().output),
                reasoning: money(split().reasoning),
              })}
            </>
          )}
        </Show>
      </p>
    </div>
  )
}

// "Sent, in detail": every item in request order with its count and labels; items sent before fold
// into "Same as call N" with their count and cache state.
export function SentDetail(props: {
  accounting: OperatorCallAccounting
  onlyNew: boolean
  expanded: boolean
  toolPrompt?: string
  subagents: OperatorCallList["session"]["subagents"]
}) {
  const language = useLanguage()
  const { n } = useNumbers()
  // Consecutive items sent in the same earlier call fold together.
  const groups = createMemo(() => {
    const out: Array<{ since?: number; items: OperatorInputItem[] }> = []
    for (const item of props.accounting.input.items) {
      if (item.kind === "parameters") continue
      const since = item.kind === "system" || item.kind === "tools" ? undefined : item.since
      const last = out.at(-1)
      if (since !== undefined && last && last.since === since) last.items.push(item)
      else out.push({ ...(since !== undefined ? { since } : {}), items: [item] })
    }
    return out
  })
  return (
    <div data-slot="operator-call-part" data-testid="call-sent-items">
      <For each={groups()}>
        {(group) => (
          <Show
            when={group.since !== undefined}
            fallback={
              <For each={group.items}>
                {(item) => (
                  <ItemView
                    item={item}
                    expanded={props.expanded}
                    toolPrompt={props.toolPrompt}
                    subagents={props.subagents}
                  />
                )}
              </For>
            }
          >
            <Show when={!props.onlyNew}>
              <SeenGroup
                group={group}
                expanded={props.expanded}
                n={n}
                toolPrompt={props.toolPrompt}
                subagents={props.subagents}
              />
            </Show>
          </Show>
        )}
      </For>
    </div>
  )
}

function SeenGroup(props: {
  group: { since?: number; items: OperatorInputItem[] }
  expanded: boolean
  n: (value: number) => string
  toolPrompt?: string
  subagents: OperatorCallList["session"]["subagents"]
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const tokens = () => props.group.items.reduce((total, item) => total + item.tokens, 0)
  const cache = () => {
    const states = new Set(props.group.items.map((item) => item.cache))
    return states.size === 1
      ? language.t(`operator.accounting.cache.${[...states][0]}` as Key)
      : language.t("operator.accounting.cache.mixed")
  }
  return (
    <div data-slot="operator-call-seen" data-testid="call-seen">
      <span data-slot="operator-note">
        {language.t("operator.accounting.sameAs", {
          call: props.group.since!,
          count: props.group.items.length,
          tokens: props.n(tokens()),
          cache: cache(),
        })}
      </span>{" "}
      <button type="button" data-slot="operator-link" onClick={() => setOpen(!open())}>
        {language.t(open() || props.expanded ? "operator.transcript.collapse" : "operator.transcript.expand")}
      </button>
      <Show when={open() || props.expanded}>
        <For each={props.group.items}>
          {(item) => (
            <ItemView item={item} expanded={props.expanded} toolPrompt={props.toolPrompt} subagents={props.subagents} />
          )}
        </For>
      </Show>
    </div>
  )
}

function ItemView(props: {
  item: OperatorInputItem
  expanded: boolean
  toolPrompt?: string
  subagents: OperatorCallList["session"]["subagents"]
}) {
  const language = useLanguage()
  const { n, money } = useNumbers()
  const openView = useOpenSessionView()
  const item = () => props.item
  const subagent = () => {
    if (item().kind !== "tool-result") return undefined
    const id = subagentOf(item().content ?? "")
    return id ? (props.subagents.find((entry) => entry.sessionID === id) ?? { sessionID: id }) : undefined
  }
  const body = (): JSX.Element => (
    <Switch fallback={<pre data-component="operator-code">{item().content}</pre>}>
      <Match when={item().kind === "tools"}>
        <table data-component="operator-accounting">
          <thead>
            <tr>
              <th scope="col">{language.t("operator.accounting.column.tool")}</th>
              <th scope="col" data-align="end">
                {language.t("operator.accounting.column.tokens")}
              </th>
              <th scope="col" data-align="end">
                {language.t("operator.accounting.column.description")}
              </th>
              <th scope="col" data-align="end">
                {language.t("operator.accounting.column.schema")}
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={item().parts ?? []}>
              {(part) => (
                <tr>
                  <th scope="row">
                    <code>{part.name}</code>
                  </th>
                  <td data-align="end">{n(part.tokens)}</td>
                  <td data-align="end">{part.description ? n(part.description.tokens) : "—"}</td>
                  <td data-align="end">{part.schema ? n(part.schema.tokens) : "—"}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={props.toolPrompt}>
          {(href) => (
            <a data-slot="operator-link" href={href()}>
              {language.t("operator.transcript.toolPrompt")}
            </a>
          )}
        </Show>
        <pre data-component="operator-code">{prettyArgs(item().content ?? "")}</pre>
      </Match>
      <Match when={item().kind === "system" && item().parts}>
        <ul data-slot="operator-accounting-sections">
          <For each={item().parts ?? []}>
            {(part) => (
              <li>
                {part.name} · {n(part.tokens)}
              </li>
            )}
          </For>
        </ul>
        <pre data-component="operator-code">{item().content}</pre>
      </Match>
      <Match when={item().kind === "tool-call"}>
        <pre data-component="operator-code">{prettyArgs(item().content ?? "")}</pre>
      </Match>
      <Match when={item().kind === "reasoning-sent"}>
        <p data-slot="operator-note">{language.t("operator.accounting.reasoningWhy")}</p>
        <Show
          when={!item().flags.includes("encrypted")}
          fallback={<p data-slot="operator-note">{language.t("operator.transcript.encrypted")}</p>}
        >
          <pre data-component="operator-code">{item().content}</pre>
        </Show>
      </Match>
      <Match when={item().kind === "attachment"}>
        <p data-slot="operator-note">
          {language.t("operator.accounting.attachmentNote", {
            size: item().attachment?.size !== undefined ? n(item().attachment!.size!) : "?",
          })}
        </p>
      </Match>
    </Switch>
  )
  const [open, setOpen] = createSignal(false)
  return (
    <div data-slot="operator-call-item" data-kind={item().kind} data-testid="call-item">
      <button
        type="button"
        data-slot="operator-call-item-head"
        aria-expanded={open() || props.expanded}
        onClick={() => setOpen(!open())}
      >
        <span class="inline-flex items-center gap-1 flex-wrap">
          <strong>{itemLabel(language, item())}</strong>
          <Flags item={item()} />
          <span data-slot="operator-note">
            {n(item().tokens)} · {language.t(methodKey(item().method))} ·{" "}
            {language.t(`operator.accounting.cache.${item().cache}` as Key)}
          </span>
        </span>
      </button>
      <Show when={subagent()}>
        {(found) => (
          <p data-slot="operator-note" data-testid="call-subagent">
            <Show
              when={"totals" in found() ? (found() as OperatorCallList["session"]["subagents"][number]) : undefined}
              fallback={language.t("operator.transcript.subagent", { id: found().sessionID })}
            >
              {(rolled) =>
                language.t("operator.accounting.subagentLine", {
                  title: rolled().title,
                  agent: rolled().agent ?? "?",
                  calls: rolled().totals.calls,
                  input: n(rolled().totals.input),
                  output: n(rolled().totals.output),
                  cost: money(rolled().totals.cost),
                })
              }
            </Show>{" "}
            <button type="button" data-slot="operator-link" onClick={() => openView(found().sessionID, "transcript")}>
              {language.t("operator.accounting.openTranscript")}
            </button>
          </p>
        )}
      </Show>
      <Show when={open() || props.expanded}>{body()}</Show>
    </div>
  )
}

// "What changed since call N": the items added and removed, what differs, and the token change.
export function ChangesPart(props: { accounting: OperatorCallAccounting }) {
  const language = useLanguage()
  const { n } = useNumbers()
  const items = createMemo(() => new Map(props.accounting.input.items.map((item) => [item.id, item])))
  return (
    <Show when={props.accounting.changes}>
      {(changes) => (
        <section data-slot="operator-call-section" data-testid="call-changes">
          <h4>{language.t("operator.accounting.changes", { call: changes().from })}</h4>
          <p data-slot="operator-note">
            {language.t(
              changes().measured ? "operator.accounting.changesMeasured" : "operator.accounting.changesBilled",
              {
                tokens: `${changes().tokens >= 0 ? "+" : ""}${n(changes().tokens)}`,
              },
            )}
          </p>
          <Show when={changes().changed.length}>
            <p data-slot="operator-note" data-warning="">
              {language.t("operator.accounting.changesChanged", {
                what: changes()
                  .changed.map((id) =>
                    id === "system"
                      ? language.t("operator.accounting.item.system")
                      : language.t("operator.accounting.toolsWord"),
                  )
                  .join(", "),
              })}
            </p>
          </Show>
          <ul data-slot="operator-accounting-changes">
            <For each={changes().added}>
              {(id) => (
                <Show when={items().get(id)}>
                  {(item) => (
                    <li data-change="added">
                      + {itemLabel(language, item())} · {n(item().tokens)}
                    </li>
                  )}
                </Show>
              )}
            </For>
            <For each={changes().removed}>
              {(item) => (
                <li data-change="removed">
                  −{" "}
                  {itemLabel(language, {
                    id: "",
                    flags: [],
                    chars: 0,
                    method: "estimate",
                    cache: "new",
                    ...item,
                  } as OperatorInputItem)}{" "}
                  · {n(item.tokens)}
                </li>
              )}
            </For>
          </ul>
        </section>
      )}
    </Show>
  )
}
