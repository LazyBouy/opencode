import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import type { OperatorPendingPermission, OperatorPermissionDecision } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { asList, ready, useOperatorClient, usePendingPermissions } from "../data"
import { formatAgo, formatDateTime, shortPath } from "../format"
import { DataTable } from "./data-table"
import { RecordField, RecordView } from "./record-overlay"
import { ReplyCard, type Via } from "./reply-card"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Which requests a place shows: one session's, an agent's (in its project), a project's, or all.
export type RequestFilter = { sessionID?: string; agent?: string; project?: string }

const matches = (filter: RequestFilter) => (item: OperatorPendingPermission) =>
  (!filter.sessionID || item.request.sessionID === filter.sessionID) &&
  (!filter.agent || item.session?.agent === filter.agent) &&
  (!filter.project || (item.project?.key ?? item.directory) === filter.project)

// The requests waiting for a reply there, as reply cards.
export function WaitingRequests(props: { filter: RequestFilter; via: Via }) {
  const language = useLanguage()
  const pending = usePendingPermissions()
  const items = () => asList(ready(pending)).filter(matches(props.filter))
  return (
    <Show
      when={items().length}
      fallback={<p data-slot="operator-note">{language.t("operator.requests.noneWaiting")}</p>}
    >
      <div data-slot="operator-reply-list">
        <For each={items()}>{(item) => <ReplyCard item={item} via={props.via} />}</For>
      </div>
    </Show>
  )
}

export function useDecisions(filter: () => RequestFilter) {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("permission-decisions", filter()),
    queryFn: () =>
      api
        .client()
        .operator.permission.decisions({
          ...(filter().sessionID ? { sessionID: filter().sessionID } : {}),
          ...(filter().agent ? { agent: filter().agent } : {}),
          ...(filter().project ? { project: filter().project } : {}),
          limit: "200",
        })
        .then((result) => asList(result.data)),
    refetchInterval: 30_000,
  }))
}

export function useDecisionText() {
  const language = useLanguage()
  return {
    decision: (record: OperatorPermissionDecision) =>
      record.decision === "deny" && record.note
        ? language.t("operator.decision.denyNote")
        : language.t(`operator.decision.${record.decision}` as Key),
    cause: (record: OperatorPermissionDecision) =>
      record.cause ? language.t(`operator.decision.cause.${record.cause}` as Key) : "",
    via: (record: OperatorPermissionDecision) => language.t(`operator.decision.via.${record.via}` as Key),
    waited: (record: OperatorPermissionDecision) =>
      `${Math.max(0, Math.round((record.decidedAt - record.askedAt) / 1000))} s`,
    rule: (record: OperatorPermissionDecision) =>
      record.rule
        ? `${record.rule.permission} ${record.rule.pattern} ${record.rule.action} · ${
            record.rule.where === "session" ? language.t("operator.decision.inSession") : shortPath(record.rule.where)
          }`
        : "",
  }
}

// Decisions there, newest first, as a table with optional columns; a row opens with every field.
export function DecidedRequests(props: { filter: RequestFilter }) {
  const language = useLanguage()
  const dialog = useDialog()
  const decisions = useDecisions(() => props.filter)
  const text = useDecisionText()
  const locale = () => language.intl()
  const open = (record: OperatorPermissionDecision) =>
    void dialog.push(() => (
      <Dialog size="large" variant="settings" class="record-overlay">
        <div class="settings-v2-tab-body" style={{ padding: "24px 32px" }}>
          <DecisionView record={record} />
        </div>
      </Dialog>
    ))
  return (
    <DataTable
      columnsKey="permission-decisions"
      label={language.t("operator.requests.decided")}
      rows={asList(ready(decisions))}
      loading={decisions.isPending}
      empty={language.t("operator.requests.noneDecided")}
      onRowClick={open}
      columns={[
        {
          id: "decided",
          header: language.t("operator.decision.column.decided"),
          value: (row) => row.decidedAt,
          cell: (row) => formatAgo(row.decidedAt, locale()),
        },
        {
          id: "decision",
          header: language.t("operator.decision.column.decision"),
          value: (row) => text.decision(row),
          cell: (row) => (
            <span class="inline-flex items-center gap-1">
              <Tag data-warning={row.decision === "deny" ? "" : undefined}>{text.decision(row)}</Tag>
              <Show when={row.cause}>
                <span data-slot="operator-note">{text.cause(row)}</span>
              </Show>
            </span>
          ),
        },
        {
          id: "permission",
          header: language.t("operator.decision.column.permission"),
          value: (row) => row.permission,
          cell: (row) => (
            <span class="flex flex-col">
              <code>{row.permission}</code>
              <span data-slot="operator-cell-clamp">{row.patterns.join(", ")}</span>
            </span>
          ),
        },
        {
          id: "session",
          optional: true,
          header: language.t("operator.decision.column.session"),
          value: (row) => row.sessionTitle ?? row.sessionID,
          cell: (row) => <span data-slot="operator-cell-clamp">{row.sessionTitle ?? row.sessionID}</span>,
        },
        {
          id: "agent",
          optional: true,
          header: language.t("operator.decision.column.agent"),
          value: (row) => row.agent ?? "",
          cell: (row) => row.agent ?? "—",
        },
        {
          id: "project",
          optional: true,
          hidden: true,
          header: language.t("operator.decision.column.project"),
          value: (row) => row.project ?? row.directory,
          cell: (row) => shortPath(row.project ?? row.directory),
        },
        {
          id: "rule",
          optional: true,
          header: language.t("operator.decision.column.rule"),
          cell: (row) => <span data-slot="operator-cell-clamp">{text.rule(row) || "—"}</span>,
        },
        {
          id: "waited",
          optional: true,
          hidden: true,
          align: "end",
          header: language.t("operator.decision.column.waited"),
          value: (row) => row.decidedAt - row.askedAt,
          cell: (row) => text.waited(row),
        },
        {
          id: "who",
          optional: true,
          hidden: true,
          header: language.t("operator.decision.column.who"),
          value: (row) => row.who,
          cell: (row) => row.who,
        },
        {
          id: "via",
          optional: true,
          header: language.t("operator.decision.column.via"),
          value: (row) => text.via(row),
          cell: (row) => text.via(row),
        },
      ]}
    />
  )
}

// A decision with every field (fixes_spec.md §4.3).
export function DecisionView(props: { record: OperatorPermissionDecision }) {
  const language = useLanguage()
  const text = useDecisionText()
  const locale = () => language.intl()
  const r = () => props.record
  return (
    <RecordView title={<Tag>{text.decision(r())}</Tag>}>
      <dl data-component="record-fields" data-testid="decision-fields">
        <RecordField
          label={language.t("operator.decision.field.asked")}
          help={language.t("operator.help.decisionAsked")}
        >
          {formatDateTime(r().askedAt, locale())}
        </RecordField>
        <RecordField
          label={language.t("operator.decision.field.decided")}
          help={language.t("operator.help.decisionDecided")}
        >
          {formatDateTime(r().decidedAt, locale())} · {text.waited(r())}
        </RecordField>
        <RecordField
          label={language.t("operator.decision.field.permission")}
          help={language.t("operator.help.decisionPermission")}
        >
          <code>{r().permission}</code> · {r().patterns.join(", ")}
        </RecordField>
        <RecordField
          label={language.t("operator.decision.field.decision")}
          help={language.t("operator.help.decisionDecision")}
        >
          {[text.decision(r()), text.cause(r())].filter(Boolean).join(" · ")}
          <Show when={r().by}>{(by) => <span data-slot="operator-note"> ({by()})</span>}</Show>
        </RecordField>
        <Show when={r().rule}>
          <RecordField
            label={language.t("operator.decision.field.rule")}
            help={language.t("operator.help.decisionRule")}
          >
            {text.rule(r())}
          </RecordField>
        </Show>
        <Show when={r().note}>
          <RecordField
            label={language.t("operator.decision.field.note")}
            help={language.t("operator.help.decisionNote")}
          >
            <span style={{ "white-space": "pre-wrap" }}>{r().note}</span>
          </RecordField>
        </Show>
        <RecordField
          label={language.t("operator.decision.field.session")}
          help={language.t("operator.help.decisionSession")}
        >
          {r().sessionTitle ?? r().sessionID}
          <Show when={r().agent}>{(agent) => <> · {agent()}</>}</Show>
        </RecordField>
        <RecordField
          label={language.t("operator.decision.field.project")}
          help={language.t("operator.help.decisionProject")}
        >
          {shortPath(r().project ?? r().directory)}
          <Show when={r().namespace}>{(ns) => <span data-slot="operator-note"> · {ns()}</span>}</Show>
        </RecordField>
        <Show when={Object.keys(r().metadata).length}>
          <RecordField
            label={language.t("operator.decision.field.details")}
            help={language.t("operator.help.decisionDetails")}
          >
            <pre data-component="operator-code">{JSON.stringify(r().metadata, null, 2)}</pre>
          </RecordField>
        </Show>
        <RecordField label={language.t("operator.decision.field.who")} help={language.t("operator.help.decisionWho")}>
          {r().who}
        </RecordField>
        <RecordField label={language.t("operator.decision.field.via")} help={language.t("operator.help.decisionVia")}>
          {text.via(r())}
        </RecordField>
      </dl>
    </RecordView>
  )
}

// Waiting and Decided, for a record's Permission requests section.
export function PermissionRequests(props: { filter: RequestFilter; via: Via }) {
  const language = useLanguage()
  const [tab, setTab] = createSignal<"waiting" | "decided">("waiting")
  return (
    <div class="flex flex-col gap-3" data-testid="permission-requests">
      <SegmentedControlV2
        class="operator-segmented-fit"
        value={tab()}
        onChange={(value) => value && setTab(value as "waiting" | "decided")}
        aria-label={language.t("operator.requests.title")}
      >
        <SegmentedControlItemV2 value="waiting">{language.t("operator.requests.waiting")}</SegmentedControlItemV2>
        <SegmentedControlItemV2 value="decided">{language.t("operator.requests.decided")}</SegmentedControlItemV2>
      </SegmentedControlV2>
      <Show when={tab() === "waiting"} fallback={<DecidedRequests filter={props.filter} />}>
        <WaitingRequests filter={props.filter} via={props.via} />
      </Show>
    </div>
  )
}
