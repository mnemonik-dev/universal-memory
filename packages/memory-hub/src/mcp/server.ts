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

// Mnemonik signing is optional. Requires MNEMONIC_IDENTITY + MNEMONIC_JWT env vars.
// Run `npx @mnemonik-xyz/cli init && npx @mnemonik-xyz/cli login` to set up.
const mnemonik = process.env.MNEMONIK_SIGNING === "true"
  ? new MnemonikAdapter({
      mode: (process.env.MNEMONIC_MODE as "local" | "participate") ?? "local",
    })
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
      const content = args.content as string;
      const result = await ingest.add({
        content,
        source: args.source as string | undefined,
        userId: args.user_id as string | undefined,
      });
      let attestationId: string | undefined;
      if (args.sign && mnemonik) {
        const signed = await mnemonik.sign(content, args.tags as string[] | undefined);
        attestationId = signed.attestationId;
      }
      return { content: [{ type: "text", text: JSON.stringify({ status: "captured", id: result.id, chunks: result.chunks, attestationId }) }] };
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
        return { content: [{ type: "text", text: JSON.stringify({ error: "Set MNEMONIK_SIGNING=true + MNEMONIC_IDENTITY + MNEMONIC_JWT to enable" }) }] };
      }
      // attestation_id is the ID returned by mnemonic_sign_memory / memory_capture with sign:true
      const result = await mnemonik.verify(args.attestation_id as string);
      // result: { status: 'verified'|'tampered'|'not_found', signer?, arweaveTx?, solanaTx? }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    case "memory_sign": {
      if (!mnemonik) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Set MNEMONIK_SIGNING=true + MNEMONIC_IDENTITY + MNEMONIC_JWT to enable" }) }] };
      }
      // Sign raw content directly via @mnemonik-xyz/sdk client.signMemory()
      const result = await mnemonik.sign(
        args.content as string,
        args.tags as string[] | undefined
      );
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
