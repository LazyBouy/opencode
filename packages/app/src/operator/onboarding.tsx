import { useLocation, useNavigate } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import { createEffect } from "solid-js"
import { ready, useOperatorClient } from "./data"

// The first start of a new installation (specs/docs/feedbacks/memory/memory_spec.md §10): until it is
// onboarded, every page of the new layout opens the welcome page.

export const WELCOME = "/operator/welcome"

export function useOnboarding() {
  const api = useOperatorClient()
  return useQuery(() => ({
    queryKey: api.key("onboarding"),
    queryFn: () =>
      api
        .client()
        .operator.onboarding.status()
        .then((result) => result.data ?? null),
    // A server without the route (another server's tab, an older build) isn't waiting for onboarding.
    retry: false,
  }))
}

/** Opens the welcome page while the server waits for onboarding. Mounted once, from the sidebar. */
export function OnboardingGate() {
  const status = useOnboarding()
  const location = useLocation()
  const navigate = useNavigate()
  createEffect(() => {
    if (ready(status)?.pending === true && location.pathname !== WELCOME) navigate(WELCOME, { replace: true })
  })
  return null
}
