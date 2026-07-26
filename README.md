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

## Roadmap

- [ ] `packages/memory-hub` — MCP server wrapping gbrain with Mnemonik signing layer
- [ ] `packages/eval` — RUMBA evaluation harness for any memory backend
- [ ] `adapters/mnemonik` — Ed25519 sign + Solana anchor for verifiable memories
- [ ] `adapters/fabric` — Fabric patterns for memory capture and recall
- [ ] Cloud sync — sync local PGLite → Postgres for cross-device access
- [ ] Multi-source ingestion — web, code repos, Slack, email, voice transcripts
