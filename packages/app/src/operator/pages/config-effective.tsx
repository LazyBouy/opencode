import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { For } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLanguage } from "@/context/language"
import { FieldHelp } from "../ui/field-help"
import { maskSecrets } from "./config-helpers"

export type ConfigSource = { kind: string; path: string; text: string; variable?: string }

// The words a config source goes by (global_and_opencode_namespaces_spec.md §3, §7.2). At a namespace's
// level there is no project: a project or `.opencode` file found there is in a folder above it.
export function useSourceLabel(namespace: () => string, level: "project" | "namespace" = "project") {
  const language = useLanguage()
  return (source: Pick<ConfigSource, "kind" | "path" | "variable">) => {
    if (source.kind === "env")
      return language.t("operator.config.kind.envOf", { variable: source.variable ?? "OPENCODE_CONFIG" })
    if (source.kind === "global")
      return source.path.includes("/.opencode/")
        ? language.t("operator.config.kind.globalHome")
        : language.t("operator.config.kind.global")
    if (source.kind === "namespace") return language.t("operator.config.kind.namespaceOf", { name: namespace() })
    return level === "namespace" ? language.t("operator.config.kind.above") : language.t("operator.config.kind.project")
  }
}

// The effective settings (merged, secrets masked), the source of each top-level key, and the sources in
// load order: the project Config page's lower half, and the same view of a namespace's or Global's config
// in Settings → Namespaces (§8).
export function ConfigEffective(props: {
  config: unknown
  origins: Record<string, string>
  /** For keys the environment sets, its variable. */
  variables?: Record<string, string>
  sources: ReadonlyArray<ConfigSource>
  label: (source: Pick<ConfigSource, "kind" | "path" | "variable">) => string
  /** The namespace's name, id and file, on a "Namespace config" source. */
  namespaceTitle?: string
  effectiveHint: string
  sourcesHint: string
  /** Inside Settings, under the section's own heading. */
  nested?: boolean
}) {
  const language = useLanguage()
  const heading = () => (props.nested ? "h4" : "h2")
  const subheading = () => (props.nested ? "h5" : "h3")
  const local = (kind: string) => kind === "project" || kind === "directory"
  return (
    <>
      <section data-component="operator-panel" data-testid="config-effective">
        <Dynamic component={heading()} data-slot="operator-panel-title">
          {language.t("operator.config.effective")}
        </Dynamic>
        <p data-slot="operator-note">{props.effectiveHint}</p>
        <pre data-component="operator-code">{JSON.stringify(maskSecrets(props.config ?? {}), null, 2)}</pre>
        <Dynamic component={subheading()} data-slot="operator-panel-title" class="flex items-center">
          {language.t("operator.config.origins")}
          <FieldHelp field={language.t("operator.config.kind.global")} text={language.t("operator.help.globalBase")} />
        </Dynamic>
        <dl data-component="record-fields" data-testid="config-origins">
          <For each={Object.entries(props.origins).toSorted((a, b) => a[0].localeCompare(b[0]))}>
            {([key, kind]) => (
              <>
                <dt>
                  <code>{key}</code>
                </dt>
                <dd title={kind === "namespace" ? props.namespaceTitle : undefined}>
                  <Tag variant={local(kind) ? "accent" : "neutral"}>
                    {props.label({ kind, path: "", variable: props.variables?.[key] })}
                  </Tag>
                </dd>
              </>
            )}
          </For>
        </dl>
      </section>

      <section data-component="operator-panel" data-testid="config-sources">
        <Dynamic component={heading()} data-slot="operator-panel-title">
          {language.t("operator.config.sources")}
        </Dynamic>
        <p data-slot="operator-note">{props.sourcesHint}</p>
        <ol data-component="operator-sources">
          <For each={props.sources}>
            {(source) => (
              <li>
                <details>
                  <summary title={source.kind === "namespace" ? props.namespaceTitle : undefined}>
                    <Tag variant={local(source.kind) || source.kind === "namespace" ? "accent" : "neutral"}>
                      {props.label(source)}
                    </Tag>
                    <code>{source.path}</code>
                  </summary>
                  <pre data-component="operator-code">{source.text}</pre>
                </details>
              </li>
            )}
          </For>
        </ol>
      </section>
    </>
  )
}
