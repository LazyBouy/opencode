import { useSearchParams } from "@solidjs/router"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useScopedProject } from "../project"
import { EmptyState } from "../ui/empty-state"
import { PageHeader } from "../ui/page-header"
import { ScopePicker } from "../ui/scope-picker"
import { IdentityLayers } from "./profile-identity"
import { FullPrompt } from "./profile-prompt"
import { PromptTexts } from "./profile-texts"

type Tab = "prompt" | "texts" | "tools" | "identity"

// Everything that goes into an agent's prompts, in one place: the assembled system prompt, every
// text OpenCode adds on its own, tool descriptions and identity layers. The tab and the text being
// edited are kept in the URL so links can point at them.
export default function ProfilePage() {
  const language = useLanguage()
  const directory = useScopedProject()
  const [params, setParams] = useSearchParams<{ tab?: string; text?: string }>()
  const tab = () => (["prompt", "texts", "tools", "identity"].includes(params.tab ?? "") ? params.tab : "prompt") as Tab

  return (
    <>
      <PageHeader
        title={language.t("operator.page.profile.title")}
        description={language.t("operator.page.profile.description")}
        actions={<ScopePicker />}
      />
      <Show
        when={directory()}
        fallback={
          <EmptyState
            icon="prompt"
            title={language.t("operator.project.none")}
            description={language.t("operator.project.noneHint")}
          />
        }
      >
        {(dir) => (
          <TabsV2 value={tab()} onChange={(value: string) => setParams({ tab: value })}>
            <TabsV2.List>
              <TabsV2.Trigger value="prompt">{language.t("operator.prompts.tab.prompt")}</TabsV2.Trigger>
              <TabsV2.Trigger value="texts">{language.t("operator.prompts.tab.texts")}</TabsV2.Trigger>
              <TabsV2.Trigger value="tools">{language.t("operator.prompts.tab.tools")}</TabsV2.Trigger>
              <TabsV2.Trigger value="identity">{language.t("operator.prompts.tab.identity")}</TabsV2.Trigger>
            </TabsV2.List>
            <TabsV2.Content value="prompt">
              <FullPrompt directory={dir()} onEdit={(next, text) => setParams({ tab: next, text })} />
            </TabsV2.Content>
            <TabsV2.Content value="texts">
              <PromptTexts
                directory={dir()}
                selected={params.text?.startsWith("tool.") ? undefined : params.text}
                onSelect={(text) => setParams({ text })}
              />
            </TabsV2.Content>
            <TabsV2.Content value="tools">
              <PromptTexts
                tools
                directory={dir()}
                selected={params.text?.startsWith("tool.") ? params.text : undefined}
                onSelect={(text) => setParams({ text })}
              />
            </TabsV2.Content>
            <TabsV2.Content value="identity">
              <IdentityLayers directory={dir()} />
            </TabsV2.Content>
          </TabsV2>
        )}
      </Show>
    </>
  )
}
