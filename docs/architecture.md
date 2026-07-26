# Architecture: Universal Memory System

## Problem Space

AI memory systems today are fragmented:
- Each tool has its own context window (no persistence)
- Memory solutions are client-specific (mem0 for Python, Claude's project memory for Claude only)
- No cryptographic provenance — memories can't be verified or audited
- Research on memory quality (RUMBA benchmark) shows significant variance across approaches

We need one memory layer that any tool can read from and write to, with proven quality and optional verifiability.

---

## Design Principles

1. **MCP-first**: Model Context Protocol is the universal adapter. Any MCP-capable client (Claude Code, Cursor, VS Code, ChatGPT, Perplexity, Windsurf) can talk to the hub without custom integration.

2. **Local by default, cloud on demand**: PGLite (embedded Postgres via WASM) requires zero server setup. The same engine runs against hosted Postgres + pgvector for multi-device sync.

3. **Synthesis over retrieval**: gbrain's synthesis layer returns cited answers, not just document chunks. Gap analysis tells consumers what the brain doesn't know yet.

4. **Verifiable provenance** (optional): Mnemonik signing layer adds Ed25519 signatures and Solana/Arweave anchoring. Any memory can be verified as authored by a specific key at a specific time.

5. **Benchmark-driven quality**: RUMBA evaluation runs against the live backend to measure retrieval accuracy, answer quality, and long-term personalization across multi-session dialogues.

---

## Component Map

### 1. Memory Hub (`packages/memory-hub/`)

The central MCP server. Wraps gbrain's engine and adds:

**Storage adapters** (`src/storage/`)
- `LocalAdapter` — PGLite (embedded, no server, git-backed markdown)
- `CloudAdapter` — Postgres + pgvector (hosted, multi-device)
- `HybridAdapter` — writes to both, reads local-first with cloud fallback

**Ingestion pipeline** (`src/ingest/`)
- `WebIngestor` — URL → markdown → embed → store
- `FileIngestor` — PDF, Markdown, code files
- `ConversationIngestor` — chat transcripts (Telegram, Slack, Claude sessions)
- `ResearchIngestor` — structured research results (RUMBA format compatible)
- `VoiceIngestor` — audio → transcript → embed → store

**Search engine** (via gbrain core)
- Vector similarity (HNSW)
- BM25 full-text
- Reciprocal Rank Fusion (RRF) hybrid scoring
- Knowledge graph traversal for entity relationships

**Signing layer** (`src/adapters/mnemonik.ts`)
- Optional: wraps writes with Ed25519 signature before storage
- Attaches COSE_Sign1 payload for blockchain anchoring
- Exposes `memory_verify` tool to check provenance

**MCP tools exposed** (`src/mcp/`)
```
memory_capture    — ingest content from any source
memory_search     — hybrid retrieval query
memory_think      — synthesis with citations + gap analysis  
memory_verify     — verify Ed25519 signature of a memory
memory_sign       — sign a memory with Mnemonik key
memory_clear      — remove memories for a user/scope
memory_sync       — push local PGLite → cloud Postgres
```

### 2. gbrain (`vendors/gbrain/`) — submodule

Core brain engine. Used as library, not forked:
- `gbrain/engine` — PGLite or Postgres engine factory
- `gbrain/search/hybrid` — Vector + BM25 + RRF search
- `gbrain/core/minions` — background job queue for async ingestion
- `gbrain/mcp` — reference MCP server (we extend, not replace)

We import from gbrain as a package dep rather than duplicating its logic.

### 3. RUMBA (`research/RUMBA/`) — reference

Benchmark framework. Used in `packages/eval/`:
- Provides standardized datasets (Russian + English, multi-session dialogues)
- Provides evaluation pipeline: ingest → retrieve → generate → judge (LLM-based)
- Defines `MemoryService` interface that memory-hub implements
- Run `packages/eval` to get accuracy scores for any storage backend

### 4. Mnemonik Adapter (`adapters/mnemonik/`)

Real integration with `mnemonik-xyz/monorepo` (submodule: `vendors/mnemonik`).

**What Mnemonik actually is** (Rust workspace + TypeScript SDK):
- `core/` — codec (CBOR/COSE), identity (Ed25519), embed (TurboQuant), compress, storage (SQLite), Solana, Arweave, lineage
- `mcp/` — MCP server binary: 5 tools, payment gate, pricing engine, OAuth 2.1
- `packages/sdk/` — `@mnemonik-xyz/sdk`: `MnemonicClient`, `LocalSigner`, `Keypair`, OAuth PKCE
- **Hosted MCP**: `https://mcp.mnemonik.xyz/mcp` — use directly as MCP server

**Write modes**:
- `local` — SQLite + Ed25519 signed, free
- `participate` — Arweave (durable storage) + Solana SPL Memo (timestamp anchor), paid

**Integration pattern**:
- `MnemonicClient.signMemory(content)` → returns `attestationId`
- `MnemonicClient.verify(attestationId)` → `{ status: 'verified' | 'tampered' | 'not_found' }`
- `MnemonicClient.recall(query)` → semantic search over signed memories

**Role**: Signs memories from universal-memory hub. `attestationId` stored alongside gbrain entry. `memory_verify` checks the COSE_Sign1 signature. Mnemonik agents read from both Mnemonik's own SQLite index and gbrain's synthesis layer.

### 5. Fabric Adapter (`adapters/fabric/`)

Fabric pattern library for memory operations:
- `memory_capture.md` — capture fabric command output to memory-hub
- `memory_recall.md` — retrieve context before a fabric pattern runs
- `memory_synthesize.md` — synthesize across recalled memories
- `research_capture.md` — pipe research results into memory-hub ingestion

Usage:
```bash
# Capture research to memory
echo "topic" | fabric --pattern research_capture

# Recall before coding
echo "task description" | fabric --pattern memory_recall | fabric --pattern write_code
```

---

## Storage Decision Matrix

| Scenario | Storage | Config |
|----------|---------|--------|
| Single dev, local only | PGLite | `GBRAIN_STORAGE=local` |
| Multi-device personal | Postgres (Railway/Render) | `GBRAIN_STORAGE=cloud` |
| Team / company brain | Postgres + OAuth scopes | `GBRAIN_STORAGE=cloud GBRAIN_MULTI_USER=true` |
| Verifiable agent memory | PGLite + Mnemonik signing | `MNEMONIK_SIGNING=true` |

---

## Memory Quality Evaluation (RUMBA)

Run evaluation against any backend:
```bash
cd packages/eval
python run.py --service memory-hub --backend local
python run.py --service memory-hub --backend cloud
python run.py --service gbrain      # baseline comparison
python run.py --service mem0        # RUMBA baseline
```

Metrics:
- **RecallAccuracy@5**: % of relevant memories retrieved in top-5
- **AnswerQuality**: LLM judge score (0-1) on personalized QA
- **TemporalConsistency**: Correct handling of time-ordered memories
- **MultiSessionRetention**: Memory persistence across session boundaries

---

## Integration Points for Consumers

### Mnemonik Protocol agents
```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": ["run", "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"],
      "env": { "MNEMONIK_SIGNING": "true", "MNEMONIK_PUBKEY": "..." }
    }
  }
}
```

### Coding Fabric (Claude Code harness)
```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": ["run", "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"],
      "env": { "GBRAIN_STORAGE": "local", "GBRAIN_GIT_DIR": "/path/to/brain-repo" }
    }
  }
}
```

### Fabric AI CLI
```bash
# ~/.fabric/config.yaml
patterns_dir: /path/to/universal-memory/adapters/fabric/patterns
memory_hub_url: http://localhost:3456
```

---

## Roadmap

### Phase 1 — Core Hub (now)
- [ ] `packages/memory-hub` MCP server wrapping gbrain engine
- [ ] LocalAdapter (PGLite), CloudAdapter (Postgres)
- [ ] Basic MCP tools: capture, search, think

### Phase 2 — Verification
- [ ] Mnemonik signing layer in memory-hub
- [ ] `adapters/mnemonik` bridge to protocol
- [ ] `memory_verify` tool + on-chain anchoring

### Phase 3 — Consumers
- [ ] `adapters/fabric` pattern library
- [ ] Mnemonik agent tools consuming memory-hub
- [ ] Coding fabric CLAUDE.md integration

### Phase 4 — Evaluation
- [ ] `packages/eval` RUMBA harness wired to memory-hub
- [ ] Benchmark memory-hub vs gbrain baseline vs mem0 vs Graphiti
- [ ] Dashboard for quality metrics

### Phase 5 — Scale
- [ ] Multi-source ingestors (web, voice, email, Slack)
- [ ] Cloud sync daemon (local PGLite → Postgres)
- [ ] Multi-user scoping (company brain mode)
