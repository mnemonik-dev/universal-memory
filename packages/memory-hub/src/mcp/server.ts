/**
 * Universal Memory Hub — MCP Server
 *
 * Wraps gbrain's engine and exposes memory tools to any MCP client:
 * Claude Code, Cursor, VS Code, ChatGPT, Perplexity, Windsurf, Fabric.
 *
 * Storage: PGLite (local, zero config) or Postgres (cloud, multi-device).
 * Signing: optional Mnemonik Ed25519 layer for verifiable memories.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StorageFactory } from "../storage/index.js";
import { CloudAdapter } from "../storage/cloud.js";
import { HybridAdapter } from "../storage/hybrid.js";
import { IngestPipeline } from "../ingest/index.js";
import { createMnemonikAdapter } from "../adapters/mnemonik.js";
import { signMemory } from "../tools/sign.js";
import type { DbClient } from "../tools/sign.js";
import { verifyMemory } from "../tools/verify.js";
import { mode, dataDir, scrubSecrets } from "../config.js";

const server = new Server(
  { name: "universal-memory", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const storage = await StorageFactory.create({
  backend: process.env.MEMORY_BACKEND ?? "local",
  gitDir: process.env.MEMORY_GIT_DIR,
  databaseUrl: process.env.DATABASE_URL,
});

// Wire the real Postgres DbClient for signMemory() idempotency (D7 — CRIT-2 fix).
// CloudAdapter and HybridAdapter expose getDbClient() which wraps engine.executeRaw().
// LocalAdapter has no database; signMemory() handles null gracefully (skips check).
let _dbClientForSigning: DbClient | null = null;
if (storage instanceof CloudAdapter || storage instanceof HybridAdapter) {
  _dbClientForSigning = await storage.getDbClient();
}

const ingest = new IngestPipeline(storage);

// Mnemonik signing is optional. Requires MNEMONIC_IDENTITY + MNEMONIC_JWT env vars.
// Run `npx @mnemonik-xyz/cli init && npx @mnemonik-xyz/cli login` to set up.
// createMnemonikAdapter() returns null with a startup warning on missing/expired JWT
// instead of crashing the server process.
const mnemonik = process.env.MNEMONIK_SIGNING === "true"
  ? createMnemonikAdapter()
  : null;

// ─── Input validation helpers ────────────────────────────────────────────────
// Clamp numeric tool arguments to safe bounds (MEDIUM-1 — OOM/DoS prevention).
// gbrain's MAX_SEARCH_LIMIT is 100; list is capped at 100 as well.

const MAX_SEARCH_TOP_K = 100;
const MAX_LIST_LIMIT = 100;

/** Clamp a numeric value to [min, max]. Returns defaultVal if value is not a number. */
function clamp(value: unknown, min: number, max: number, defaultVal: number): number {
  const n = typeof value === "number" ? value : defaultVal;
  return Math.min(Math.max(min, n), max);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_capture",
      description: "Ingest content into the memory hub from any source (text, URL, file path, or structured data). Content is chunked, embedded, and indexed for hybrid retrieval.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The content to store" },
          source: { type: "string", description: "Optional source identifier (URL, file path, topic)" },
          user_id: { type: "string", description: "User scope for multi-user deployments" },
          sign: { type: "boolean", description: "Sign with Mnemonik Ed25519 key (requires MNEMONIK_SIGNING=true + MNEMONIC_IDENTITY + MNEMONIC_JWT)" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for the Mnemonik attestation" },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_search",
      description: "Hybrid search across all stored memories using vector similarity, BM25 keyword match, and RRF fusion. Returns ranked results with source citations.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          user_id: { type: "string", description: "User scope filter" },
          top_k: { type: "number", description: "Number of results (default: 10)" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_think",
      description: "Synthesize a cited answer from stored memories. Returns structured prose with citations and explicit gap analysis (what the brain doesn't know yet).",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to answer from memory" },
          user_id: { type: "string", description: "User scope filter" },
        },
        required: ["question"],
      },
    },
    {
      name: "memory_verify",
      description: "Verify a Mnemonik attestation by its attestationId. Checks COSE_Sign1 Ed25519 signature. In participate mode also checks Arweave/Solana anchors. Returns: verified | tampered | not_found.",
      inputSchema: {
        type: "object",
        properties: {
          attestation_id: { type: "string", description: "The attestationId returned by memory_capture (with sign:true) or memory_sign" },
        },
        required: ["attestation_id"],
      },
    },
    {
      name: "memory_sign",
      description: "Sign content with the configured Mnemonik Ed25519 key via @mnemonik-xyz/sdk. Uses local mode (SQLite, free) or participate mode (Arweave + Solana, paid) based on MNEMONIC_MODE env var.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "Content to sign" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags for the attestation" },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_list",
      description: "List stored memories, most recent first. Returns up to limit entries (default: 20).",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum number of entries to return (default: 20)" },
          user_id: { type: "string", description: "User scope filter" },
        },
        required: [],
      },
    },
    {
      name: "memory_delete",
      description: "Delete a specific memory entry by id. Returns { status: 'deleted' } on success or an error object if not found.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The id of the memory entry to delete" },
          user_id: { type: "string", description: "User scope filter" },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_sync",
      description: "Sync local PGLite brain to cloud Postgres for cross-device access. Pushes all local memories not yet in cloud.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["push", "pull", "bidirectional"], description: "Sync direction (default: push)" },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "memory_capture": {
      const content = args.content as string;
      const result = await ingest.add({
        content,
        source: args.source as string | undefined,
        userId: args.user_id as string | undefined,
      });
      let attestationId: string | undefined;
      if (args.sign) {
        // Use signMemory() so idempotency and error handling are consistent.
        // _dbClientForSigning is the real Postgres client in cloud/hybrid mode (D7 CRIT-2 fix).
        // In local mode it is null — signMemory() handles null gracefully (skips idempotency check).
        const signed = await signMemory({
          content,
          tags: args.tags as string[] | undefined,
          adapter: mnemonik,
          db: _dbClientForSigning,
        });
        attestationId = signed.attestationId;
      }
      return { content: [{ type: "text", text: JSON.stringify({ status: "captured", id: result.id, chunks: result.chunks, attestationId }) }] };
    }

    case "memory_search": {
      const results = await storage.search({
        query: args.query as string,
        userId: args.user_id as string | undefined,
        topK: clamp(args.top_k, 1, MAX_SEARCH_TOP_K, 10),
      });
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }

    case "memory_think": {
      const result = await storage.synthesize({
        question: args.question as string,
        userId: args.user_id as string | undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_verify": {
      // Delegates to verifyMemory() — handles null adapter (signing not configured)
      // and translates SDK errors into user-facing messages.
      const result = await verifyMemory({
        attestationId: args.attestation_id as string,
        adapter: mnemonik,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_sign": {
      // Delegates to signMemory() — handles idempotency via memory_attestations table,
      // null adapter (signing not configured / local mode), and SDK errors.
      // _dbClientForSigning is the real Postgres client in cloud/hybrid mode (D7 CRIT-2 fix).
      const result = await signMemory({
        content: args.content as string,
        tags: args.tags as string[] | undefined,
        adapter: mnemonik,
        db: _dbClientForSigning,
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_list": {
      const limit = clamp(args.limit, 1, MAX_LIST_LIMIT, 20);
      const results = await storage.list({
        limit,
        userId: args.user_id as string | undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }

    case "memory_delete": {
      const id = args.id as string;
      try {
        await storage.delete({ id, userId: args.user_id as string | undefined });
        return { content: [{ type: "text", text: JSON.stringify({ status: "deleted" }) }] };
      } catch (e: unknown) {
        // Return structured error rather than crashing on not-found
        const code = (e as any)?.code;
        const message = e instanceof Error ? e.message : String(e);
        if (code === "not_found") {
          return { content: [{ type: "text", text: JSON.stringify({ error: "not_found", id }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ error: message }) }] };
      }
    }

    case "memory_sync": {
      const result = await storage.sync({ direction: (args.direction as string) ?? "push" });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ─── Transport mode selector ─────────────────────────────────────────────────
// D3: cloud mode uses HTTP MCP transport (Bun.serve + WebStandard SSE).
// D13: never print MEMORY_API_KEY value, even in debug output.

const backend = process.env.MEMORY_BACKEND ?? "local";

if (backend === "cloud") {
  const apiKey = process.env.MEMORY_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      "[universal-memory] FATAL: MEMORY_API_KEY is required in cloud mode.\n"
    );
    process.exit(1);
  }

  // Lazy import to avoid loading Bun-specific serve code in stdio mode
  const { startHttpServer, DEFAULT_MCP_PORT } = await import("./http.js");
  const httpPort = parseInt(process.env.MEMORY_HTTP_PORT ?? String(DEFAULT_MCP_PORT), 10);

  await startHttpServer({ mcpServer: server, port: httpPort, apiKey });

  // D13: show key status (set/missing) but never the value
  process.stderr.write(
    `[universal-memory] Universal Memory Hub ready (cloud/HTTP)\n` +
    `[universal-memory] Listening on port ${httpPort}\n` +
    `[universal-memory] MEMORY_API_KEY: (set)\n` +
    `[universal-memory] AI mode: ${mode}\n`
  );
} else {
  // local (default) — stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Print startup status to stderr (not stdout — MCP uses stdout for JSON-RPC)
  if (mode === "bm25-only") {
    process.stderr.write(
      `[universal-memory] Universal Memory Hub ready (local/PGLite, BM25-only mode)\n` +
      `[universal-memory] Data dir: ${dataDir}\n` +
      `[universal-memory] For semantic search, set OPENAI_API_KEY or run: bunx universal-memory setup\n`
    );
  } else {
    process.stderr.write(
      `[universal-memory] Universal Memory Hub ready (local/PGLite)\n` +
      `[universal-memory] Data dir: ${dataDir}\n` +
      `[universal-memory] AI mode: ${mode}\n`
    );
  }
}
