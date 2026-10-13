import type {
  OperatorResolverCandidateTrace,
  OperatorResolverInnerTrace,
  OperatorResolverTrace,
} from "@opencode-ai/sdk/v2/client"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"

// A Dynamic layer's resolution (dynamic_layer_resolution_spec.md §2.6): every candidate its sources gave,
// what reading it gave, the filter that left it out, its score and the rules' parts (a helper judge's too, with
// what the judge did), and whether it was selected or why not. Shown under a Dynamic section on the agent page and
// in the Transcript.

type Trace = OperatorResolverTrace | OperatorResolverInnerTrace

const points = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(2))

function Candidates(props: { trace: Trace; title: string }) {
  const language = useLanguage()
  const name = (item: OperatorResolverCandidateTrace) => item.name ?? item.location.split("/").at(-1) ?? item.location
  return (
    <details data-component="operator-resolution" data-testid="prompt-resolution">
      <summary>
        {props.title}{" "}
        <span data-slot="operator-note">
          {language.t("operator.resolution.summary", {
            count: props.trace.candidates.length,
            policy: language.t(`operator.resolution.policy.${props.trace.policy}`),
            chars: props.trace.chars,
          })}
          <Show when={props.trace.overBudget}>
            {" · "}
            {language.t("operator.resolution.overBudget", { count: props.trace.overBudget })}
          </Show>
        </span>
      </summary>
      <Show when={props.trace.off}>
        {(off) => <p data-slot="operator-note">{language.t("operator.resolution.off", { reason: off() })}</p>}
      </Show>
      <Show when={props.trace.judge}>
        {(judge) => (
          <p
            data-slot="operator-note"
            data-warning={judge().status === "failed" || judge().status === "missing" ? "" : undefined}
            data-testid="resolution-judge"
          >
            {language.t(`operator.resolution.judge.${judge().status}`, {
              helper: judge().helper,
              error: judge().error ?? "",
            })}
          </p>
        )}
      </Show>
      <Show when={props.trace.candidates.length}>
        <table data-component="operator-table">
          <thead>
            <tr>
              <th>{language.t("operator.resolution.candidate")}</th>
              <th>{language.t("operator.resolution.group")}</th>
              <th>{language.t("operator.resolution.read")}</th>
              <th>{language.t("operator.resolution.score")}</th>
              <th>{language.t("operator.resolution.outcome")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.trace.candidates}>
              {(item) => (
                <tr data-selected={item.selected ? "" : undefined} data-testid="resolution-candidate">
                  <td title={item.location}>
                    <code>{name(item)}</code>
                    <Show when={item.location !== name(item)}>
                      <span data-slot="operator-note"> {item.location}</span>
                    </Show>
                  </td>
                  <td>{item.group ?? "—"}</td>
                  <td>{language.t(`operator.resolution.readAs.${item.read}`)}</td>
                  <td title={item.parts.map((part) => `${part.rule}: ${points(part.points)}`).join("\n") || undefined}>
                    {item.filtered ? "—" : points(item.score)}
                    <Show when={!item.filtered && item.parts.find((part) => part.rule.startsWith("judge ("))}>
                      {(part) => (
                        <span data-slot="operator-note">
                          {" "}
                          {language.t("operator.resolution.judgePoints", { points: points(part().points) })}
                        </span>
                      )}
                    </Show>
                  </td>
                  <td>
                    <Show when={item.selected} fallback={<span data-slot="operator-note">{item.why}</span>}>
                      <Tag variant="accent">{language.t("operator.resolution.selected")}</Tag>
                      <Show when={item.cut}>
                        <span data-slot="operator-note"> {language.t("operator.resolution.cut")}</span>
                      </Show>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </details>
  )
}

export function Resolution(props: { trace?: OperatorResolverTrace; parity?: "same" | "differs" }) {
  const language = useLanguage()
  return (
    <Show when={props.trace}>
      {(trace) => (
        <div class="flex flex-col gap-1">
          <Show when={props.parity === "differs"}>
            <p data-slot="operator-note" data-warning="" data-testid="resolution-differs">
              {language.t("operator.resolution.differs")}
            </p>
          </Show>
          <Candidates trace={trace()} title={language.t("operator.resolution.title")} />
          <Show when={trace().inner}>
            {(inner) => (
              <Candidates trace={inner()} title={language.t("operator.resolution.inner", { layer: inner().layer })} />
            )}
          </Show>
        </div>
      )}
    </Show>
  )
}
