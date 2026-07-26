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
import { IngestPipeline } from "../ingest/index.js";
import { MnemonikAdapter } from "../adapters/mnemonik.js";

const server = new Server(
  { name: "universal-memory", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const storage = await StorageFactory.create({
  backend: process.env.MEMORY_BACKEND ?? "local",
  gitDir: process.env.MEMORY_GIT_DIR,
  databaseUrl: process.env.DATABASE_URL,
});

const ingest = new IngestPipeline(storage);

const mnemonik = process.env.MNEMONIK_SIGNING === "true"
  ? new MnemonikAdapter({ pubkey: process.env.MNEMONIK_PUBKEY })
  : null;

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
          sign: { type: "boolean", description: "Sign with Mnemonik key (requires MNEMONIK_SIGNING=true)" },
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
      description: "Verify the Ed25519 signature of a memory entry. Returns signature validity, signer pubkey, and Solana anchor transaction if available.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory entry ID to verify" },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "memory_sign",
      description: "Sign a memory entry with the configured Mnemonik Ed25519 key and optionally anchor to Solana for tamper-proof timestamping.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory entry ID to sign" },
          anchor: { type: "boolean", description: "Also anchor to Solana chain (requires SOLANA_RPC configured)" },
        },
        required: ["memory_id"],
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
    {
      name: "memory_clear",
      description: "Remove all memories for a user or scope. Irreversible unless git-backed storage is used.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User scope to clear" },
          confirm: { type: "boolean", description: "Must be true to execute" },
        },
        required: ["user_id", "confirm"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "memory_capture": {
      const result = await ingest.add({
        content: args.content as string,
        source: args.source as string | undefined,
        userId: args.user_id as string | undefined,
      });
      if (args.sign && mnemonik) {
        await mnemonik.sign(result.id);
      }
      return { content: [{ type: "text", text: JSON.stringify({ status: "captured", id: result.id, chunks: result.chunks }) }] };
    }

    case "memory_search": {
      const results = await storage.search({
        query: args.query as string,
        userId: args.user_id as string | undefined,
        topK: (args.top_k as number) ?? 10,
      });
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }

    case "memory_think": {
      const answer = await storage.synthesize({
        question: args.question as string,
        userId: args.user_id as string | undefined,
      });
      return { content: [{ type: "text", text: answer }] };
    }

    case "memory_verify": {
      if (!mnemonik) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Mnemonik signing not configured" }) }] };
      }
      const result = await mnemonik.verify(args.memory_id as string);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_sign": {
      if (!mnemonik) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Mnemonik signing not configured" }) }] };
      }
      const result = await mnemonik.sign(args.memory_id as string, { anchor: args.anchor as boolean });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_sync": {
      const result = await storage.sync({ direction: (args.direction as string) ?? "push" });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_clear": {
      if (!args.confirm) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "confirm must be true" }) }] };
      }
      await storage.clear({ userId: args.user_id as string });
      return { content: [{ type: "text", text: JSON.stringify({ status: "cleared", user_id: args.user_id }) }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
