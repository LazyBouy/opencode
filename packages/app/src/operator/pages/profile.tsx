import { useSearchParams } from "@solidjs/router"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Match, Switch } from "solid-js"
import { useLanguage } from "@/context/language"
import { PageHeader } from "../ui/page-header"
import { GroupDefinition } from "./profile-groups"
import { LayerDefinition } from "./profile-layers"
import { ProfileDefinition } from "./profile-profiles"

type View = "layers" | "groups" | "profiles"
const VIEWS: View[] = ["layers", "groups", "profiles"]

// Prompt profiles, server-wide: layers (pieces of prompt text), groups (ordered layers) and profiles
// (ordered groups an agent's system prompt is built from). The view and what is open are in the URL.
// An agent's assembled prompt is on its page, under Prompt.
export default function ProfilePage() {
  const language = useLanguage()
  const [params, setParams] = useSearchParams<{ view?: string }>()
  const view = () => (VIEWS.find((item) => item === params.view) ?? "layers") as View

  return (
    <>
      <PageHeader
        title={language.t("operator.page.profile.title")}
        description={language.t("operator.page.profile.description")}
        actions={
          <SelectV2<View>
            appearance="inline"
            aria-label={language.t("operator.profile.view")}
            options={VIEWS}
            current={view()}
            label={(item) => language.t(`operator.profile.view.${item}`)}
            onSelect={(item) =>
              item && setParams({ view: item, layer: undefined, group: undefined, profile: undefined })
            }
          />
        }
      />
      <Switch>
        <Match when={view() === "layers"}>
          <LayerDefinition />
        </Match>
        <Match when={view() === "groups"}>
          <GroupDefinition />
        </Match>
        <Match when={view() === "profiles"}>
          <ProfileDefinition />
        </Match>
      </Switch>
    </>
  )
}
