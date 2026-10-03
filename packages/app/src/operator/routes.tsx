import { Navigate, Route } from "@solidjs/router"
import { type Component, lazy } from "solid-js"
import { type OperatorPage, operatorPages } from "./pages"
import { PlannedPage } from "./pages/planned"
import { OperatorShell } from "./shell"

// Pages that are built; the rest show what they will do.
const built: Partial<Record<OperatorPage["id"], Component>> = {
  dashboard: lazy(() => import("./pages/dashboard")),
  agents: lazy(() => import("./pages/agents")),
  sessions: lazy(() => import("./pages/sessions")),
  inbox: lazy(() => import("./pages/inbox")),
  config: lazy(() => import("./pages/config")),
  models: lazy(() => import("./pages/models")),
  capabilities: lazy(() => import("./pages/capabilities")),
}
const AgentPage = lazy(() => import("./pages/agent"))

// All /operator routes. Mounted once from app.tsx inside the new layout.
export function OperatorRoutes() {
  return (
    <Route path="/operator" component={OperatorShell}>
      {operatorPages.map((page) => (
        <Route path={page.path.slice("/operator".length) || "/"} component={built[page.id] ?? (() => <PlannedPage page={page} />)} />
      ))}
      <Route path="/agents/:name" component={AgentPage} />
      <Route path="*" component={() => <Navigate href="/operator" />} />
    </Route>
  )
}
