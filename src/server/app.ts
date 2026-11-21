/**
 * The server bundle's entry: `boot()` runs the startup sequence once, `app` handles every HTTP
 * request (an Express app, so it also works as a `(req, res, next)` middleware).
 *
 *   1. response compression, except for streamed responses (`./http/compression.ts`)
 *   2. security headers on every response, static files and 404s included
 *   3. production only: the client build (`/assets` immutable for a year, the rest an hour)
 *   4. the fetch pipeline (`./http/handler.ts`) around React Router
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import express from "express";
import { createRequestHandler, type ServerBuild } from "react-router";

import { compressResponses } from "./http/compression";
import { createAppHandler } from "./http/handler";
import { createNodeListener } from "./http/nodeListener";
import { boundRequestOrigin } from "./http/requestOrigin";
import {
  decodePathname,
  normalizeBasePath,
  routingPathname,
  stripBasePath,
} from "./http/requestPath";
import { securityHeadersFor } from "./http/securityHeaders";

export { boot } from "./boot";

const DEVELOPMENT = import.meta.env.DEV;

// A production build never changes, so resolve it once: React Router then computes its route
// table once. Given a function it rebuilds the table on every request (about 4 ms with ~750
// routes); development needs that so edits show up.
const build: ServerBuild | (() => Promise<ServerBuild>) = DEVELOPMENT
  ? () => import("virtual:react-router/server-build")
  : await import("virtual:react-router/server-build");

const productionBasePath = typeof build === "function" ? null : normalizeBasePath(build.basename);

async function basePath(): Promise<string> {
  if (productionBasePath !== null) return productionBasePath;
  const current = typeof build === "function" ? await build() : build;
  return normalizeBasePath(current.basename);
}

const render = createRequestHandler(build, DEVELOPMENT ? "development" : "production");

const handleRequest = createNodeListener(createAppHandler({ basePath, render }), {
  // `request.url` is built from the bound address, never from the client's Host header.
  ...boundRequestOrigin(),
  onError(error) {
    // The client gets a bare 500; the details stay in the log.
    console.error("[server] Unhandled request error:", error);
  },
});

async function setSecurityHeaders(
  req: IncomingMessage & { originalUrl?: string },
  res: ServerResponse,
  next: (error?: unknown) => void
): Promise<void> {
  try {
    const pathname = new URL(req.originalUrl || req.url || "/", "http://localhost").pathname;
    const stripped = stripBasePath(pathname, await basePath()) ?? pathname;
    for (const [name, value] of securityHeadersFor(routingPathname(decodePathname(stripped)))) {
      res.setHeader(name, value);
    }
    next();
  } catch (error) {
    next(error);
  }
}

function createApp() {
  const server = express();
  server.disable("x-powered-by");
  server.use(compressResponses);
  server.use(setSecurityHeaders);

  if (!DEVELOPMENT && productionBasePath !== null) {
    const clientDir = fileURLToPath(new URL("../client/", import.meta.url));
    const mount = productionBasePath || "/";
    server.use(
      `${productionBasePath}/assets`,
      express.static(`${clientDir}assets`, {
        immutable: true,
        maxAge: "1y",
        index: false,
        redirect: false,
      })
    );
    server.use(mount, express.static(clientDir, { maxAge: "1h", index: false, redirect: false }));
  }

  server.use((req: IncomingMessage, res: ServerResponse) => handleRequest(req, res));
  return server;
}

/** Node request listener for every page, endpoint and static file. */
export const app = createApp();
