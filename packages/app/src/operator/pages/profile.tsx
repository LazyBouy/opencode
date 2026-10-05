import { useSearchParams } from "@solidjs/router"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { useLanguage } from "@/context/language"
import { NamespacePicker, useNamespaceScope } from "../ui/namespace-picker"
import { PageHeader } from "../ui/page-header"
import { GroupDefinition } from "./profile-groups"
import { LayerDefinition } from "./profile-layers"
import { ProfileDefinition } from "./profile-profiles"

type Tab = "layers" | "groups" | "profiles"
const TABS: Tab[] = ["layers", "groups", "profiles"]

// Prompt profiles of the namespaces in scope (all, or one organization): layers (pieces of prompt
// text), groups (orders of group types) and profiles (a group and the layers in each of its slots).
// The namespace scope is shared with the other pages; the tab and what is open are in the URL. An
// agent's prompt is on its page, under Prompt.
export default function ProfilePage() {
  const language = useLanguage()
  const scope = useNamespaceScope()
  const [params, setParams] = useSearchParams<{ tab?: string }>()
  const tab = () => TABS.find((item) => item === params.tab) ?? "layers"
  // Leaving a namespace or a tab closes what was open in it.
  const closed = {
    layer: undefined,
    group: undefined,
    type: undefined,
    profile: undefined,
    rns: undefined,
    block: undefined,
    q: undefined,
  }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.profile.title")}
        description={language.t("operator.page.profile.description")}
        actions={<NamespacePicker onChange={() => setParams(closed)} />}
      />
      <TabsV2 value={tab()} onChange={(value: string) => setParams({ tab: value, ...closed })}>
        <TabsV2.List>
          <TabsV2.Trigger value="layers">{language.t("operator.profile.tab.layers")}</TabsV2.Trigger>
          <TabsV2.Trigger value="groups">{language.t("operator.profile.tab.groups")}</TabsV2.Trigger>
          <TabsV2.Trigger value="profiles">{language.t("operator.profile.tab.profiles")}</TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content value="layers">
          <LayerDefinition ns={scope.ns()} namespaces={scope.namespaces()} />
        </TabsV2.Content>
        <TabsV2.Content value="groups">
          <GroupDefinition ns={scope.ns()} namespaces={scope.namespaces()} />
        </TabsV2.Content>
        <TabsV2.Content value="profiles">
          <ProfileDefinition ns={scope.ns()} namespaces={scope.namespaces()} />
        </TabsV2.Content>
      </TabsV2>
    </>
  )
}
