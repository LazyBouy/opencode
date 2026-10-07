import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useScopedProject } from "../project"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"
import { ConfigEditor } from "./config-editor"

export default function ConfigPage() {
  const language = useLanguage()
  const directory = useScopedProject()
  return (
    <>
      <PageHeader
        title={language.t("operator.page.config.title")}
        description={language.t("operator.page.config.description")}
        actions={<ScopePicker />}
      />
      <Show
        when={directory()}
        fallback={
          <EmptyState
            icon="sliders"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        {(folder) => <ConfigEditor directory={folder()} />}
      </Show>
    </>
  )
}
