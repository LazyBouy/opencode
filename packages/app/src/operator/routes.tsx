import { Navigate, Route } from "@solidjs/router"
import { operatorPages } from "./pages"
import { PlannedPage } from "./pages/planned"
import { OperatorShell } from "./shell"

// All /operator routes. Mounted once from app.tsx inside the new layout.
export function OperatorRoutes() {
  return (
    <Route path="/operator" component={OperatorShell}>
      {operatorPages.map((page) => (
        <Route path={page.path.slice("/operator".length) || "/"} component={() => <PlannedPage page={page} />} />
      ))}
      <Route path="*" component={() => <Navigate href="/operator" />} />
    </Route>
  )
}
