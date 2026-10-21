import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import type { MessagePartProps } from "@opencode-ai/session-ui/message-part"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { type By, hookMarks, type Mark, messageMarks } from "./hook-marks"

type Key = Parameters<ReturnType<typeof useLanguage>["t"]>[0]

// Under a tool call, in every view: what hooks did to it (hook-marks.ts).
export function HookMarks(props: { part: MessagePartProps["part"] }) {
  const marks = createMemo(() => hookMarks(props.part))
  return <HookMarkList marks={marks()} />
}

// Under a user message, in every view: its text a hook changed, and the context hooks added to it.
export function MessageHookMarks(props: { parts: () => ReadonlyArray<{ type: string; metadata?: unknown }> }) {
  const marks = createMemo(() => messageMarks(props.parts()))
  return <HookMarkList marks={marks()} testid="message-hook-marks" />
}

// Each mark names its hooks; hovering one shows its level, file and run.
export function HookMarkList(props: { marks: Mark[]; testid?: string }) {
  const language = useLanguage()
  const marks = () => props.marks
  const names = (by: By[]) => by.map((item) => item.hook).join(", ")
  const origin = (by: By[]) =>
    by
      .map((item) =>
        language.t("operator.hooks.mark.origin", {
          hook: item.hook,
          level: language.t(`operator.levels.level.${item.level}` as Key),
          file: item.file,
          run: item.run,
        }),
      )
      .join("\n")
  return (
    <Show when={marks().length}>
      <div data-component="operator-hook-marks" data-testid={props.testid ?? "hook-marks"}>
        <For each={marks()}>
          {(mark) => (
            <Switch>
              <Match when={mark.kind === "denied" && mark}>
                {(denied) => (
                  <div data-slot="operator-extra" data-kind="hook-denied" data-testid="hook-mark">
                    <Tag data-warning="">{language.t("operator.hooks.mark.denied", { hook: denied().hook })}</Tag>
                    <Show when={denied().reason}>
                      <span>{denied().reason}</span>
                    </Show>
                  </div>
                )}
              </Match>
              <Match when={mark.kind === "no-continue" && mark}>
                {(stopped) => (
                  <div
                    data-slot="operator-extra"
                    data-kind="hook-no-continue"
                    data-testid="hook-mark"
                    title={origin([stopped().by])}
                  >
                    <Tag>{language.t("operator.hooks.mark.noContinue", { hook: stopped().by.hook })}</Tag>
                  </div>
                )}
              </Match>
              <Match when={mark.kind === "withheld" && mark}>
                {(withheld) => (
                  <div
                    data-slot="operator-extra"
                    data-kind="hook-withheld"
                    data-testid="hook-mark"
                    title={origin([withheld().by])}
                  >
                    <Tag data-warning="">
                      {language.t("operator.hooks.mark.withheld", { hook: withheld().by.hook })}
                    </Tag>
                    <span>{withheld().reason}</span>
                  </div>
                )}
              </Match>
              <Match
                when={
                  (mark.kind === "input" || mark.kind === "prompt" || mark.kind === "output" || mark.kind === "text") &&
                  mark
                }
              >
                {(change) => (
                  <details
                    data-slot="operator-extra"
                    data-kind={`hook-${change().kind}`}
                    data-testid="hook-mark"
                    title={origin(change().by)}
                  >
                    <summary>
                      <Tag>
                        {language.t(`operator.hooks.mark.${change().kind}` as Key, { hook: names(change().by) })}
                      </Tag>{" "}
                      {language.t("operator.hooks.mark.original")}
                    </summary>
                    <pre data-component="operator-code">{change().original}</pre>
                  </details>
                )}
              </Match>
              <Match when={mark.kind === "context" && mark}>
                {(context) => (
                  <details
                    data-slot="operator-extra"
                    data-kind="hook-context"
                    data-testid="hook-mark"
                    title={origin([context().by])}
                  >
                    <summary>
                      <Tag>{language.t("operator.hooks.mark.context", { hook: context().by.hook })}</Tag>{" "}
                      {firstLine(context().text)}
                    </summary>
                    <pre data-component="operator-code">{context().text}</pre>
                  </details>
                )}
              </Match>
            </Switch>
          )}
        </For>
      </div>
    </Show>
  )
}

const firstLine = (text: string) => {
  const line = text.split("\n")[0] ?? ""
  return line.length > 120 ? line.slice(0, 119) + "…" : line
}
