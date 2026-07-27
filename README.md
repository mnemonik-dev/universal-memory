# Universal Memory

A unified, verifiable, cross-client memory system for AI agents and humans.

## Goal

A single memory layer that:
- Works from **any AI tool or client surface** (Claude Code, Cursor, VS Code, ChatGPT, Perplexity, Fabric, CLI)
- **Unites knowledge from multiple sources** (research, code, conversations, web, files, voice)
- Runs **locally or in the cloud** with the same API
- Provides **cryptographic provenance** via Mnemonik protocol integration
- Is **evaluated** against the RUMBA benchmark for quality assurance

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CONSUMERS / CLIENTS                       │
│  Claude Code │ Cursor │ VS Code │ Fabric patterns │ Agents  │
└──────────────────────┬──────────────────────────────────────┘
                       │ MCP (stdio / HTTP)
┌──────────────────────▼──────────────────────────────────────┐
│                   MEMORY HUB (MCP Server)                    │
│  packages/memory-hub/                                        │
│  • Hybrid search (vector + BM25 + RRF)                       │
│  • Self-wiring knowledge graph                               │
│  • Multi-source ingestion pipeline                           │
│  • Mnemonik signing layer (Ed25519 + Solana anchor)          │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
┌────────▼────────┐         ┌────────▼────────┐
│  LOCAL STORAGE  │         │  CLOUD STORAGE  │
│  PGLite (WASM)  │         │  Postgres +     │
│  No server req  │         │  pgvector       │
└─────────────────┘         └─────────────────┘
```

## Project Structure

```
universal-memory/
├── vendors/
│   └── gbrain/              # git submodule — core brain engine (Garry Tan / YC)
├── research/
│   └── RUMBA/               # Benchmark: evaluates memOS, mem0, Graphiti, Cortex, RAG
├── packages/
│   ├── memory-hub/          # Main MCP server (extends gbrain)
│   └── eval/                # RUMBA-based evaluation harness
├── adapters/
│   ├── fabric/              # Fabric AI framework integration (patterns)
│   └── mnemonik/            # Mnemonik protocol adapter (verifiable memories)
└── docs/
    └── architecture.md
```

## Core Vendors

### Mnemonik (submodule: `vendors/mnemonik`)
- **Repo**: `mnemonik-xyz/monorepo` — Rust workspace, `@mnemonik-xyz/sdk`, hosted MCP server
- **Why**: The actual verifiable memory protocol this project is built around.
  Ed25519 signing, COSE_Sign1 artifacts, Arweave durable storage, Solana timestamp anchoring.
- **Role**: Signing and provenance layer. Universal-memory stores and retrieves; Mnemonik proves.

### gbrain (submodule: `vendors/gbrain`)
- **Why**: Production-ready, MCP-native brain layer. PGLite locally, Postgres in cloud.
  Hybrid search (vector + BM25 + RRF), self-wiring knowledge graph, synthesis layer.
  Benchmarked: P@5 49.1%, R@5 97.9%. Already used at 146K pages in production.
- **Role**: Storage engine and search backbone. memory-hub wraps and extends it.

### RUMBA (research: `research/RUMBA`)
- **Why**: Best available benchmark for long-term personalized AI memory across multi-session
  dialogues. Tests memOS, mem0, Graphiti, Cortex, and RAG baselines.
- **Role**: Evaluation harness. Run `packages/eval` against any memory backend to measure quality.

## Consumers

### Mnemonik Protocol (`adapters/mnemonik/`)
- Source: `mnemonik-xyz/monorepo` (submodule: `vendors/mnemonik/`)
- Hosted MCP: `https://mcp.mnemonik.xyz/mcp` — use as standalone or alongside memory-hub
- SDK: `@mnemonik-xyz/sdk` — `MnemonicClient.signMemory()` / `.recall()` / `.verify()`
- Write modes: `local` (SQLite, free) or `participate` (Arweave + Solana anchor, paid)
- When `MNEMONIK_SIGNING=true`: every `memory_capture` also signs via Mnemonik and stores `attestationId`

### Fabric AI (`adapters/fabric/`)
- Fabric patterns that call memory-hub MCP tools
- Patterns: `enrich_context`, `research_capture`, `session_recall`, `knowledge_synthesize`
- Fabric's `--pattern` pipeline → capture output → memory-hub ingestion

## Quick Start

```bash
# Install
cd vendors/gbrain && bun install

# Start local memory hub (PGLite, no server required)
bun run packages/memory-hub/src/mcp/server.ts

# Configure in Claude Code (~/.claude/settings.json)
# "mcpServers": { "universal-memory": { "command": "bun", "args": ["..."] } }
```

## Client Configuration

Universal Memory Hub exposes 7 MCP tools: `memory_capture`, `memory_search`, `memory_think`,
`memory_sign`, `memory_verify`, `memory_list`, `memory_delete`.

Two connection modes:
- **Local (stdio)** — Bun subprocess, PGLite storage, no server required.
- **Cloud (HTTP)** — HTTPS endpoint on your VPS, shared state across all clients.

### Claude Code

Add to `~/.claude/settings.json` or `.claude/settings.json` in your project:

**Local mode (stdio):**
```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"
      ],
      "env": {
        "MEMORY_BACKEND": "local",
        "OPENAI_API_KEY": "<your-key>"
      }
    }
  }
}
```

**Cloud mode (HTTP MCP):**
```json
{
  "mcpServers": {
    "universal-memory": {
      "type": "http",
      "url": "https://memory.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer <MEMORY_API_KEY>"
      }
    }
  }
}
```

After adding the config, run `/mcp` in Claude Code to verify the 7 tools are listed.

### KimiClaw (OpenClaw on Kimi)

KimiClaw supports MCP via its OpenClaw integration. Add the universal-memory server in
the OpenClaw MCP settings panel.

**Cloud (recommended — works across sessions):**
```json
{
  "mcpServers": {
    "universal-memory": {
      "type": "streamable-http",
      "url": "https://memory.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer <MEMORY_API_KEY>"
      }
    }
  }
}
```

**Local (stdio, if KimiClaw supports subprocess MCP):**
```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"
      ],
      "env": {
        "MEMORY_BACKEND": "local",
        "OPENAI_API_KEY": "<your-key>"
      }
    }
  }
}
```

### Kini

Kini supports remote MCP servers via HTTP. Add universal-memory in Kini's MCP
configuration settings.

**Cloud mode:**
```json
{
  "mcpServers": {
    "universal-memory": {
      "type": "http",
      "url": "https://memory.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer <MEMORY_API_KEY>"
      }
    }
  }
}
```

**Local mode (stdio):**
```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": [
        "run",
        "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"
      ],
      "env": {
        "MEMORY_BACKEND": "local",
        "OPENAI_API_KEY": "<your-key>"
      }
    }
  }
}
```

### Coding Fabric

Coding Fabric agents use universal-memory through Claude Code (or KimiClaw) MCP config
already configured above. The `adapters/fabric/CLAUDE.md` file provides the system prompt
that instructs Fabric agents when and how to use memory tools automatically.

Copy or symlink `adapters/fabric/CLAUDE.md` into your Fabric project root:

```bash
cp /path/to/universal-memory/adapters/fabric/CLAUDE.md ~/your-fabric-project/CLAUDE.md
```

The prompt instructs agents to:
1. Call `memory_search` at the start of every task to load relevant context.
2. Call `memory_capture` after completing research or making architectural decisions.
3. Call `memory_think` for synthesis when the task involves ambiguous context.

**E2E-4 verification:** After installing the Fabric CLAUDE.md, start a new Fabric task:
```
fabric --pattern write_code "implement a caching layer"
```
The agent should invoke `memory_search` before starting and `memory_capture` after
completing the task. Verify by checking `memory_list` shows the new entry.

### Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `MEMORY_BACKEND` | No | `local` (default) or `cloud` |
| `OPENAI_API_KEY` | No* | LLM key for semantic search + synthesis |
| `ANTHROPIC_API_KEY` | No* | Alternative LLM provider |
| `GOOGLE_API_KEY` | No* | Alternative LLM provider |
| `MEMORY_DATA_DIR` | No | PGLite data path (default: `~/.universal-memory/brain/`) |
| `DATABASE_URL` | Cloud only | Postgres 15+ with pgvector |
| `MEMORY_API_KEY` | Cloud only | Bearer token for HTTP auth |
| `MNEMONIK_SIGNING` | No | `true` to enable Ed25519 signing |
| `MNEMONIC_JWT` | Signing only | From `npx @mnemonik-xyz/cli login` |
| `MNEMONIC_IDENTITY` | Signing only | From `npx @mnemonik-xyz/cli init` |

\* Without any LLM key: BM25-only mode (keyword search, no synthesis). Set at least one for
semantic search and `memory_think`.

## Roadmap

- [ ] `packages/memory-hub` — MCP server wrapping gbrain with Mnemonik signing layer
- [ ] `packages/eval` — RUMBA evaluation harness for any memory backend
- [ ] `adapters/mnemonik` — Ed25519 sign + Solana anchor for verifiable memories
- [ ] `adapters/fabric` — Fabric patterns for memory capture and recall
- [ ] Cloud sync — sync local PGLite → Postgres for cross-device access
- [ ] Multi-source ingestion — web, code repos, Slack, email, voice transcripts
