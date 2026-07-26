# Mnemonik → Universal Memory Bridge

This adapter makes universal-memory the persistent store for Mnemonik protocol agents.

## How It Works

Mnemonik protocol agents call `mnemonic_sign_memory` and `mnemonic_recall` via MCP.
This adapter routes those calls through universal-memory's `memory_hub` MCP server,
so all agent memories are stored in the same brain as human-written notes, research, and code.

The signing layer adds cryptographic provenance on top of gbrain's storage:
- Ed25519 signature proves WHO wrote the memory
- COSE_Sign1 payload proves WHAT was written and WHEN
- Solana anchor proves WHEN at blockchain-level finality

## MCP Tool Mapping

| Mnemonik Tool | Universal Memory Tool | Notes |
|---|---|---|
| `mnemonic_sign_memory` | `memory_capture` + `memory_sign` | Capture first, then sign |
| `mnemonic_recall` | `memory_think` | Synthesis with citations |
| `mnemonic_verify` | `memory_verify` | Ed25519 + Solana check |

## Configuration

```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": ["run", "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"],
      "env": {
        "MNEMONIK_SIGNING": "true",
        "MNEMONIK_PUBKEY": "<your-ed25519-pubkey>",
        "MNEMONIK_API_URL": "https://mnemonik.xyz/api",
        "MEMORY_BACKEND": "local"
      }
    }
  }
}
```

## Integration with Mnemonik Protocol

The mnemon repo (https://github.com/mnemon-dev/mnemon) uses:
- Rust workspace for core protocol
- TurboQuant for semantic compression
- Solana SPL Memo for anchoring

universal-memory acts as the storage and retrieval layer that mnemon agents query.
Mnemon handles the cryptographic layer; universal-memory handles the search and synthesis.
