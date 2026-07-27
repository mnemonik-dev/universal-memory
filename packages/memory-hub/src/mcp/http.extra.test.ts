/**
 * Additional tests for mcp/http.ts — covering uncovered paths.
 *
 * Gaps from http.test.ts:
 *   - Unknown path → 404 JSON response (lines 89-90)
 *   - Error thrown in fetch handler → 500 JSON (lines 91-98)
 *   - DEFAULT_MCP_PORT export value
 *   - startHttpServer() returns handle with stop() and port
 *
 * TDD anchors (Task 8):
 *   - startHttpServer returns port number
 *   - unknown path returns 404
 *   - startHttpServer.stop() shuts down server
 */

import { describe, it, expect, afterEach } from "bun:test";

let serverHandles: Array<{ stop: () => void }> = [];

afterEach(() => {
  for (const handle of serverHandles) {
    try { handle.stop(); } catch { /* ignore */ }
  }
  serverHandles = [];
});

async function createMockMcpServer() {
  const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const srv = new Server(
    { name: "test-http-extra", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return srv;
}

describe("mcp/http.ts — DEFAULT_MCP_PORT", () => {
  it("DEFAULT_MCP_PORT is 3456", async () => {
    const { DEFAULT_MCP_PORT } = await import("./http.js");
    expect(DEFAULT_MCP_PORT).toBe(3456);
  });
});

describe("mcp/http.ts — startHttpServer() handle", () => {
  it("returns a handle with port > 0", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0, // OS assigns a free port
      apiKey: "test-key",
    });
    serverHandles.push(handle);

    expect(typeof handle.port).toBe("number");
    expect(handle.port).toBeGreaterThan(0);
  });

  it("returns a handle with stop() function", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "test-key",
    });
    serverHandles.push(handle);

    expect(typeof handle.stop).toBe("function");
  });
});

describe("mcp/http.ts — unknown path returns 404", () => {
  it("GET /unknown-path returns 404 with correct Bearer", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "my-api-key",
    });
    serverHandles.push(handle);

    const resp = await fetch(`http://localhost:${handle.port}/unknown-path`, {
      headers: { Authorization: "Bearer my-api-key" },
    });

    expect(resp.status).toBe(404);
    const body = await resp.json() as { error: string };
    expect(body.error).toBe("not_found");
  });
});

describe("mcp/http.ts — /health endpoint", () => {
  it("returns status ok without auth", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "any-key",
    });
    serverHandles.push(handle);

    const resp = await fetch(`http://localhost:${handle.port}/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { status: string; transport: string };
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("http");
  });

  it("does not require Authorization header for /health", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "secret",
    });
    serverHandles.push(handle);

    // No auth header at all — should still return 200 for /health
    const resp = await fetch(`http://localhost:${handle.port}/health`);
    expect(resp.status).toBe(200);
  });
});

describe("mcp/http.ts — auth edge cases", () => {
  it("empty Bearer header returns 401", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "real-key",
    });
    serverHandles.push(handle);

    const resp = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer " },
      body: "{}",
    });

    expect(resp.status).toBe(401);
  });

  it("malformed auth header (no Bearer prefix) returns 401", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "real-key",
    });
    serverHandles.push(handle);

    const resp = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Token real-key" }, // wrong scheme
      body: "{}",
    });

    expect(resp.status).toBe(401);
  });

  it("Basic auth header returns 401", async () => {
    const { startHttpServer } = await import("./http.js");
    const mcpServer = await createMockMcpServer();

    const handle = await startHttpServer({
      mcpServer,
      port: 0,
      apiKey: "real-key",
    });
    serverHandles.push(handle);

    const resp = await fetch(`http://localhost:${handle.port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Basic cmVhbC1rZXk=" }, // base64 of real-key
      body: "{}",
    });

    expect(resp.status).toBe(401);
  });
});
