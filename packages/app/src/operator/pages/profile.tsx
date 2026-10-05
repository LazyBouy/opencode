import { useSearchParams } from "@solidjs/router"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import type { OperatorNamespaceSummary } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { PageHeader } from "../ui/page-header"
import { useNamespaces } from "./profile-data"
import { GroupDefinition } from "./profile-groups"
import { LayerDefinition } from "./profile-layers"
import { OPENCODE } from "./profile-model"
import { ProfileDefinition } from "./profile-profiles"

type Tab = "layers" | "groups" | "profiles"
const TABS: Tab[] = ["layers", "groups", "profiles"]

// Prompt profiles of one namespace (an organization): layers (pieces of prompt text), groups (orders
// of group types) and profiles (a group and the layers in each of its slots). The namespace, the tab
// and what is open are in the URL. An agent's prompt is on its page, under Prompt.
export default function ProfilePage() {
  const language = useLanguage()
  const namespaces = useNamespaces()
  const [params, setParams] = useSearchParams<{ ns?: string; tab?: string }>()
  const list = () => namespaces.data ?? []
  const ns = () => list().find((item) => item.namespace.id === params.ns)?.namespace.id ?? params.ns ?? OPENCODE
  const tab = () => TABS.find((item) => item === params.tab) ?? "layers"
  // Leaving a namespace or a tab closes what was open in it.
  const closed = { layer: undefined, group: undefined, type: undefined, profile: undefined, q: undefined }

  return (
    <>
      <PageHeader
        title={language.t("operator.page.profile.title")}
        description={language.t("operator.page.profile.description")}
        actions={
          <SelectV2<OperatorNamespaceSummary>
            appearance="base"
            aria-label={language.t("operator.profile.namespace")}
            options={list()}
            current={list().find((item) => item.namespace.id === ns())}
            value={(item) => item.namespace.id}
            label={(item) => item.namespace.name}
            onSelect={(item) => item && setParams({ ns: item.namespace.id, ...closed })}
          />
        }
      />
      <TabsV2 value={tab()} onChange={(value: string) => setParams({ tab: value, ...closed })}>
        <TabsV2.List>
          <TabsV2.Trigger value="layers">{language.t("operator.profile.tab.layers")}</TabsV2.Trigger>
          <TabsV2.Trigger value="groups">{language.t("operator.profile.tab.groups")}</TabsV2.Trigger>
          <TabsV2.Trigger value="profiles">{language.t("operator.profile.tab.profiles")}</TabsV2.Trigger>
        </TabsV2.List>
        <TabsV2.Content value="layers">
          <LayerDefinition ns={ns()} namespaces={list()} />
        </TabsV2.Content>
        <TabsV2.Content value="groups">
          <GroupDefinition ns={ns()} namespaces={list()} />
        </TabsV2.Content>
        <TabsV2.Content value="profiles">
          <ProfileDefinition ns={ns()} namespaces={list()} />
        </TabsV2.Content>
      </TabsV2>
    </>
  )
}
