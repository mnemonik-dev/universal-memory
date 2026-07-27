# Universal Memory — Coding Fabric Agent Instructions

You are a coding agent with access to a persistent memory hub via MCP tools.
The memory hub stores research findings, architectural decisions, code patterns,
and accumulated context from previous sessions. Use it actively — your memory
does not reset between sessions when you use these tools.

## MCP Tools Available

| Tool | When to use | Input | Output |
|---|---|---|---|
| `memory_search` | Before any task — load prior context | `{ query, top_k? }` | `[{ id, content, score }]` |
| `memory_capture` | After research, decisions, or completed tasks | `{ content, source?, tags? }` | `{ id, chunks }` |
| `memory_think` | When you need synthesis across multiple memories | `{ question }` | `{ answer, citations, gaps }` |
| `memory_sign` | To create a verifiable Ed25519 attestation for a stored memory | `{ id }` | `{ attestationId, contentHash }` |
| `memory_verify` | To verify the authenticity of a signed memory | `{ attestation_id }` | `{ verified, signer, timestamp }` |
| `memory_list` | To browse recent captures | `{ limit? }` | `[{ id, content, created_at }]` |
| `memory_delete` | To remove outdated or incorrect entries | `{ id }` | `{ status }` |

## When to Use Memory Tools

### BEFORE starting any task:

```
memory_search({ query: "<task topic or keywords>" })
```

Always recall before acting. This surfaces prior decisions, research, and patterns
that may be directly relevant. Do not start coding without checking memory first.

If results are sparse or ambiguous, use `memory_think` for synthesis:

```
memory_think({ question: "What do I know about <topic>? What are the key decisions?" })
```

### AFTER completing significant work:

Capture the result, decision, or insight. Be specific and self-contained:

```
memory_capture({
  content: "Decided to use BM25-only mode as default when no LLM API key is present. Rationale: ...",
  source: "architecture-decision",
  tags: ["search", "config", "bm25"]
})
```

Capture each of:
- Architectural decisions with their rationale
- Research findings (what you learned about a library, API, or system)
- Bug root causes and their fixes
- Test patterns that worked
- API shapes discovered by reading source code

### DURING a research task:

When you read source code, docs, or external resources and find something non-obvious:

```
memory_capture({
  content: "gbrain createEngine() takes { engine: 'postgres' } only — DATABASE_URL goes to engine.connect() not to createEngine(). Confirmed from PostgresEngine.connect() source.",
  source: "code-research",
  tags: ["gbrain", "postgres", "api"]
})
```

Do not wait until the end to capture — capture while the finding is fresh.

## MCP Server Configuration

Add to your Claude Code `~/.claude/settings.json` or `.claude/settings.json`:

**Local mode (PGLite, no server required):**
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

**Cloud mode (persistent across devices, recommended for Fabric):**
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

Replace `/path/to/universal-memory` with the actual path and `<your-key>` with
your API key. Cloud mode is recommended for Fabric — memories persist across
sessions and are shared across all agent surfaces (Claude Code, KimiClaw, Kini).

## Quality Standards for Memory Captures

Each captured entry must be **independently useful 6 months from now** without
requiring surrounding context. Prefer specific and concrete over vague:

**Good:**
```
"pdf-parse v2 exports PDFParse as a named class, not a default function.
Use: import { PDFParse } from 'pdf-parse'; const p = new PDFParse({ data: uint8array });
The legacy default-export API is v1 only."
```

**Bad:**
```
"pdf-parse works differently in v2"
```

Tag captures with topic tags to make future search more effective:
- `["architecture", "decision"]` — for design choices
- `["bug", "fix", "<component>"]` — for bug root causes
- `["api", "<library-name>"]` — for library API discoveries
- `["pattern", "<language>"]` — for reusable code patterns

## E2E-4: Fabric Agent Memory Integration Verification

To verify the memory integration works end-to-end:

1. Start a Fabric task that involves research:
   ```
   fabric --pattern write_code "implement Redis caching for the API"
   ```

2. The agent should call `memory_search` before starting:
   ```
   memory_search({ query: "Redis caching API patterns" })
   ```

3. After completing the task, the agent should capture:
   ```
   memory_capture({
     content: "Implemented Redis caching using ioredis with 5-minute TTL. Key pattern: cache:<entity>:<id>. Invalidation on write via cache.del().",
     source: "implementation",
     tags: ["redis", "caching", "api"]
   })
   ```

4. In a new session, verify the memory persists:
   ```
   memory_search({ query: "Redis caching" })
   ```
   Should return the captured entry.

5. For synthesis:
   ```
   memory_think({ question: "What caching patterns have we used and what are the tradeoffs?" })
   ```
   Should return an answer with citations pointing to captured entries.
