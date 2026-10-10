import { mergeConfig, type UserConfig } from "vite"
import app from "./vite.config"

// The fork's dev stack (docker/dev/compose.yaml): the app's own config, served on one origin with the API.
// Vite serves the app and forwards everything else (the API, its event stream, the terminal's WebSocket) to
// the server inside Docker's network, so the browser uses one server: the one the app is served from.

const target = process.env.OPENCODE_DEV_API ?? "http://server:4096"

// What stays with Vite: its own requests (all under /@: @vite, @id, @fs, @solid-refresh, …) and the app's
// files. A page load (HTML) is the app too. No API path starts with /@ or ends in a file extension.
const VITE =
  /^\/(?:@|__|src\/|node_modules\/|[^?]*\.(?:[cm]?[jt]sx?|css|svg|png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|json|map|webmanifest|wasm|txt)(?:\?|$))/

export default mergeConfig(app, {
  server: {
    proxy: {
      // The terminal: a WebSocket. Only these upgrades are forwarded; Vite keeps its own (hot reload).
      "^/(?:api/)?pty/[^/]+/connect": { target, ws: true },
      "^/": {
        target,
        bypass: (req) => (req.headers.accept?.includes("text/html") || VITE.test(req.url ?? "/") ? req.url : undefined),
      },
    },
  },
} satisfies UserConfig)
