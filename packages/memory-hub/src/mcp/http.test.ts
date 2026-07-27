/**
 * Tests for mcp/http.ts — HTTP MCP server on port 3456
 *
 * TDD anchors from task 2:
 *   - starts_on_port_3456
 *   - returns_401_before_mcp_dispatch
 */

import { describe, it, expect, afterEach } from "bun:test";

// We test the exported startHttpServer and stopHttpServer
// to avoid actually binding ports during unit tests we use port 0 or a test port.
// The actual port 3456 behavior is verified in the smoke test.

describe("mcp/http.ts", () => {
  describe("starts_on_port_3456", () => {
    it("default port is 3456", async () => {
      // Import module and check DEFAULT_PORT export
      const { DEFAULT_MCP_PORT } = await import("./http.js");
      expect(DEFAULT_MCP_PORT).toBe(3456);
    });
  });

  describe("returns_401_before_mcp_dispatch", () => {
    let server: { stop: () => void; port: number } | null = null;

    afterEach(() => {
      server?.stop();
      server = null;
    });

    it("returns 401 JSON with missing Authorization header", async () => {
      const { startHttpServer } = await import("./http.js");

      // Start on a random port to avoid conflicts
      server = await startHttpServer({
        mcpServer: createMockMcpServer(),
        port: 0,
        apiKey: "secret-key",
      });

      const resp = await fetch(`http://localhost:${server.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      expect(resp.status).toBe(401);
      const body = await resp.json() as { error: string };
      expect(body).toHaveProperty("error");
    });

    it("returns 401 JSON with wrong Bearer token", async () => {
      const { startHttpServer } = await import("./http.js");

      server = await startHttpServer({
        mcpServer: createMockMcpServer(),
        port: 0,
        apiKey: "secret-key",
      });

      const resp = await fetch(`http://localhost:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      expect(resp.status).toBe(401);
    });

    it("returns non-401 with correct Bearer token", async () => {
      const { startHttpServer } = await import("./http.js");

      server = await startHttpServer({
        mcpServer: createMockMcpServer(),
        port: 0,
        apiKey: "secret-key",
      });

      const resp = await fetch(`http://localhost:${server.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer secret-key",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } } }),
      });

      // The MCP transport will respond — not a 401
      expect(resp.status).not.toBe(401);
    });

    it("/health endpoint works without auth", async () => {
      const { startHttpServer } = await import("./http.js");

      server = await startHttpServer({
        mcpServer: createMockMcpServer(),
        port: 0,
        apiKey: "secret-key",
      });

      const resp = await fetch(`http://localhost:${server.port}/health`);
      expect(resp.status).toBe(200);
      const body = await resp.json() as { status: string };
      expect(body.status).toBe("ok");
    });
  });
});

/**
 * Creates a minimal mock MCP Server that can be connected to a transport.
 * We use the real MCP SDK Server to ensure transport integration works.
 */
function createMockMcpServer() {
  // Lazy import to avoid top-level await
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

  const mcpServer = new Server(
    { name: "test-server", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [],
  }));

  return mcpServer;
}
