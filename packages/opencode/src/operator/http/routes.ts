import { Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ServerAuth } from "@/server/auth"
import { authorizationLayer } from "@/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "@/server/routes/instance/httpapi/middleware/schema-error"
import { OperatorRootApi } from "./api"
import { operatorRootHandlers } from "./handlers"

// The server-wide operator routes as one layer, merged into the server's routes beside RootHttpApi.
export const operatorRootRoutes = HttpApiBuilder.layer(OperatorRootApi).pipe(
  Layer.provide([...operatorRootHandlers]),
  Layer.provide([schemaErrorLayer, authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))]),
)
