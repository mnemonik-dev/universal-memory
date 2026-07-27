/**
 * HTTP MCP transport for Universal Memory Hub (cloud mode).
 *
 * Uses WebStandardStreamableHTTPServerTransport from @modelcontextprotocol/sdk —
 * the Bun-native implementation that accepts Web Standard Request/Response.
 * StreamableHTTPServerTransport wraps Node.js HTTP and should NOT be used with Bun.
 *
 * Architecture:
 *   Bun.serve → auth middleware (validateBearer) → MCP transport.handleRequest()
 *
 * Security:
 * - D4: Bearer auth is defense-in-depth (nginx is primary)
 * - D10: validateBearer() uses crypto.timingSafeEqual()
 * - D13: startup log never prints MEMORY_API_KEY value
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { validateBearer, create401Response } from "./auth.js";
import { scrubSecrets } from "../config.js";

/** Default port for cloud/HTTP mode. Must match nginx proxy_pass config. */
export const DEFAULT_MCP_PORT = 3456;

export interface HttpServerOptions {
  /** The MCP Server instance (already registered with tool handlers). */
  mcpServer: Server;
  /** Port to listen on. Defaults to DEFAULT_MCP_PORT (3456). */
  port?: number;
  /** MEMORY_API_KEY — used for Bearer auth. Required in cloud mode. */
  apiKey: string;
}

export interface HttpServerHandle {
  /** The Bun.Server instance. Call stop() to shut down. */
  stop: () => void;
  /** Actual port bound (useful when port: 0 is used in tests). */
  port: number;
}

/**
 * Start the HTTP MCP server.
 *
 * Creates a NEW WebStandardStreamableHTTPServerTransport per call.
 * Connects the given mcpServer to the transport.
 *
 * @returns A handle with stop() and the actual bound port.
 */
export async function startHttpServer(
  opts: HttpServerOptions
): Promise<HttpServerHandle> {
  const { mcpServer, apiKey } = opts;
  const port = opts.port ?? DEFAULT_MCP_PORT;

  // Create stateless MCP transport (no session management needed for single-user).
  // stateless = sessionIdGenerator: undefined
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Connect MCP server to this transport. Idempotent — safe to call once.
  await mcpServer.connect(transport);

  const bunServer = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const path = url.pathname;

        // Health check: no auth required. Used by Docker/nginx health probes.
        if (path === "/health") {
          // Use bunServer.port for the actual bound port (correct when port:0 used in tests)
          return Response.json({ status: "ok", transport: "http" });
        }

        // All other routes require Bearer auth (D4 defense-in-depth, D10 timing-safe)
        const authHeader = req.headers.get("Authorization");
        if (!validateBearer(authHeader, apiKey)) {
          return create401Response();
        }

        // Only /mcp is dispatched to the MCP transport
        if (path === "/mcp") {
          // WebStandardStreamableHTTPServerTransport.handleRequest() accepts a
          // Web Standard Request and returns a Web Standard Response — Bun native.
          return transport.handleRequest(req);
        }

        return Response.json({ error: "not_found" }, { status: 404 });
      } catch (e: unknown) {
        // D13: scrub secrets from error messages before logging
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(
          `[universal-memory] HTTP request error: ${scrubSecrets(msg)}\n`
        );
        return Response.json({ error: "internal_error" }, { status: 500 });
      }
    },
    error(err: Error): Response {
      // D13: scrub secrets from error messages before logging (Bun connection-level errors)
      process.stderr.write(
        `[universal-memory] HTTP connection error: ${scrubSecrets(err.message)}\n`
      );
      return Response.json({ error: "internal_error" }, { status: 500 });
    },
  });

  return {
    stop: () => bunServer.stop(),
    port: bunServer.port,
  };
}
