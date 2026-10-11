import { useSearchParams } from "@solidjs/router"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { createMemo, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { NamespacePicker, useNamespaceScope } from "../ui/namespace-picker"
import { PageHeader } from "../ui/page-header"
import { useRecordOverlay } from "../ui/record-overlay"
import { DatabaseSection, FilesTab, MemoryOverlay, SummariesTab, useNamespaceMemory } from "./memory-files"
import { MemoryEntryOverlay, MemoryLevelsTab, MemorySettingsTab } from "./memory-levels"
import { OPENCODE } from "./profile-model"

// What agents remember, for one namespace (memory_spec.md §8, scoped as the user set on 2026-10-11): the
// namespace picker at the top scopes every tab. Memory shows the namespace's memory, then a project's
// (picked just above it), then an agent's of that project (picked just above it); Files the files
// OpenCode adds to prompts for the namespace's projects; Summaries their compaction summaries; Settings
// the namespace's memory settings and the server's database.
type Params = {
  tab?: string
  file?: string
  fproject?: string
  summary?: string
  memory?: string
  mproject?: string
  magent?: string
}

const TABS = ["memory", "files", "summaries", "settings"]

export default function MemoryPage() {
  const language = useLanguage()
  const scope = useNamespaceScope()
  const [params, setParams] = useSearchParams<Params>()
  // The namespace the page shows: the one chosen (with all namespaces chosen, OpenCode's).
  const namespace = () => (scope.all() ? OPENCODE : scope.ns())
  const summary = createMemo(() => scope.namespaces().find((item) => item.namespace.id === namespace()))
  const projects = () => summary()?.projects ?? []
  // Instruction files apply only to OpenCode's and Global's projects.
  const instructions = () => namespace() === OPENCODE || !!summary()?.global
  const project = () => (params.mproject && projects().includes(params.mproject) ? params.mproject : projects()[0])
  const memory = useNamespaceMemory({ namespace, projects, instructions })

  useRecordOverlay(
    () => !!(params.file || params.summary),
    () => <MemoryOverlay memory={memory} />,
    ["file", "fproject", "summary"],
  )
  useRecordOverlay(
    () => !!params.memory,
    () => <MemoryEntryOverlay namespace={namespace()} project={project()} agent={params.magent} />,
    ["memory"],
  )
  const tab = () => (TABS.includes(params.tab ?? "") ? params.tab! : "memory")

  return (
    <>
      <PageHeader
        title={language.t("operator.page.memory.title")}
        description={language.t("operator.page.memory.description")}
        actions={
          <NamespacePicker
            all={false}
            current={namespace()}
            onChange={() => setParams({ mproject: undefined, magent: undefined })}
          />
        }
      />
      <TabsV2 value={tab()} onChange={(next: string) => setParams({ tab: next })}>
        <TabsV2.List>
          <TabsV2.Trigger value="memory">{language.t("operator.memory.tab.memory")}</TabsV2.Trigger>
          <TabsV2.Trigger value="files">
            {language.t("operator.memory.tab.files", { count: memory.files().length })}
          </TabsV2.Trigger>
          <TabsV2.Trigger value="summaries">{language.t("operator.memory.tab.summaries")}</TabsV2.Trigger>
          <TabsV2.Trigger value="settings">{language.t("operator.memory.tab.settings")}</TabsV2.Trigger>
        </TabsV2.List>

        <TabsV2.Content value="memory">
          <MemoryLevelsTab
            namespace={namespace()}
            instructions={instructions()}
            projects={projects()}
            project={project()}
            agent={params.magent}
            onProject={(key) => setParams({ mproject: key, magent: undefined })}
            onAgent={(agent) => setParams({ magent: agent })}
            onOpen={(record) => setParams({ memory: record })}
          />
        </TabsV2.Content>

        <TabsV2.Content value="files">
          <Show when={!instructions()}>
            <p data-slot="operator-note">{language.t("operator.memoryLevels.instructionsElsewhere")}</p>
          </Show>
          <FilesTab memory={memory} onOpen={(path, key) => setParams({ file: path, fproject: key })} />
        </TabsV2.Content>

        <TabsV2.Content value="summaries">
          <SummariesTab memory={memory} onOpen={(session) => setParams({ summary: session })} />
        </TabsV2.Content>

        <TabsV2.Content value="settings">
          <div class="flex flex-col gap-4">
            <MemorySettingsTab namespace={namespace()} />
            <DatabaseSection database={memory.database()} />
          </div>
        </TabsV2.Content>
      </TabsV2>
    </>
  )
}
