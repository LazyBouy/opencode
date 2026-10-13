import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "./select"
import { createMemo, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { shortPath } from "../format"
import { useNamespaces } from "../pages/profile-data"
import { NotAProjectDialog } from "../project-gate"
import { type ProjectOption, useOperatorProjects, useScopedProject } from "../project"
import { useOperatorScope } from "../scope"
import { FieldHelp } from "./field-help"
import { IdChip } from "./id-chip"

type Option = Partial<ProjectOption> & { label: string }

// Chooses the project an operator page shows. Pages that work across projects pass `all` to offer
// "All projects"; the others always show one project. The projects are the Projects page's, grouped by namespace,
// each labelled "name · id", its folder shown on hover; beside the picker, the chosen project's and its namespace's
// ids (specs/docs/issues/002). A link to a folder that isn't a project says so, and offers to make it one.
export function ScopePicker(props: { all?: boolean }) {
  const language = useLanguage()
  const dialog = useDialog()
  const scope = useOperatorScope()
  const projects = useOperatorProjects()
  const scoped = useScopedProject()
  const namespaces = useNamespaces()
  const selected = () => (props.all ? scope.directory() : scoped())
  const namespaceOf = (id: string) => namespaces.data?.find((item) => item.namespace.id === id)
  const options = createMemo<Option[]>(() => [
    ...(props.all ? [{ label: language.t("operator.scope.all") }] : []),
    ...projects(),
  ])
  const grouped = () => new Set(projects().map((item) => item.namespace)).size > 1
  const current = () => projects().find((item) => item.directory === selected())
  const notProject = () => {
    const linked = scope.linked()
    return linked && projects().length && !projects().some((item) => item.directory === linked) ? linked : undefined
  }
  return (
    <span class="inline-flex flex-wrap items-center gap-2">
      <Show
        when={notProject()}
        fallback={
          <span class="inline-flex items-center">
            <SelectV2<Option>
              appearance="inline"
              aria-label={language.t("operator.scope.picker")}
              options={options()}
              current={options().find((option) => option.directory === selected()) ?? options()[0]}
              value={(option) => option.directory ?? "*"}
              label={(option) => option.label}
              optionTitle={(option) => option.directory}
              {...(grouped()
                ? {
                    groupBy: (option: Option) =>
                      option.namespace ? (namespaceOf(option.namespace)?.namespace.name ?? option.namespace) : "",
                  }
                : {})}
              onSelect={(option) => scope.setDirectory(option?.directory)}
            />
            <FieldHelp field={language.t("operator.scope.picker")} text={language.t("operator.help.scopePicker")} />
          </span>
        }
      >
        {(folder) => (
          <span class="inline-flex flex-wrap items-center gap-2" role="status" data-testid="scope-not-project">
            <span data-slot="operator-note">{language.t("operator.scope.notProject")}</span>
            <code title={folder()}>{shortPath(folder())}</code>
            <ButtonV2
              size="small"
              variant="outline"
              onClick={() =>
                void dialog.show(() => <NotAProjectDialog directory={folder()} onDone={() => dialog.close()} />)
              }
            >
              {language.t("operator.scope.makeProject")}
            </ButtonV2>
            <ButtonV2 size="small" variant="neutral" onClick={() => scope.setDirectory(projects()[0]?.directory)}>
              {language.t("operator.scope.chooseProject")}
            </ButtonV2>
          </span>
        )}
      </Show>
      <Show when={current()}>
        {(project) => (
          <>
            <IdChip
              label={language.t("operator.ids.namespace")}
              id={project().namespace}
              path={namespaceOf(project().namespace)?.namespace.folder}
              help={language.t("operator.help.namespaceId")}
              testid="scope-namespace-id"
            />
            <Show when={project().id}>
              <IdChip
                label={language.t("operator.ids.project")}
                id={project().id}
                path={project().directory}
                help={language.t("operator.help.projectId")}
                testid="scope-project-id"
              />
            </Show>
          </>
        )}
      </Show>
    </span>
  )
}
