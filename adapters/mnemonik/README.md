# Mnemonik → Universal Memory Bridge

Bridges `universal-memory` with the real Mnemonik protocol (`mnemonik-xyz/monorepo`).

**Submodule:** `vendors/mnemonik/` — the full Rust workspace + TypeScript SDK + MCP server  
**Hosted MCP:** `https://mcp.mnemonik.xyz/mcp`  
**npm SDK:** `@mnemonik-xyz/sdk`

## How It Works

Mnemonik already exposes its own MCP server with 5 tools (`mnemonic_sign_memory`, `mnemonic_recall`, `mnemonic_verify`, `mnemonic_prove_identity`, `mnemonic_whoami`). Universal-memory consumes that MCP surface as one of its **ingest sources** and **signing layers** — rather than reimplementing it.

```
Agent / Fabric / Claude Code
        │
        ▼
  universal-memory MCP (memory_capture / memory_search / memory_think)
        │
        ├── gbrain engine (storage + hybrid search + synthesis)
        │
        └── Mnemonik MCP (optional signing layer)
                │
                ├── local mode: SQLite + Ed25519 (free, no chain)
                └── participate mode: Arweave + Solana anchor (paid, tamper-proof)
```

## Integration Modes

### Mode A — Mnemonik as signing layer (recommended)

Universal-memory stores and retrieves memories; Mnemonik adds cryptographic provenance.  
When `MNEMONIK_SIGNING=true`, every `memory_capture` call also calls `mnemonic_sign_memory` on the Mnemonik MCP server and stores the returned `attestationId` with the memory entry.

`memory_verify` then calls `mnemonic_verify(attestationId)` to check the COSE_Sign1 signature.

### Mode B — Mnemonik MCP as standalone memory backend

Point Claude Code / Cursor / any MCP client directly at `https://mcp.mnemonik.xyz/mcp` for pure Mnemonik storage. Universal-memory is not in the loop.

## MCP Tool Mapping

| Mnemonik tool | Universal Memory tool | Notes |
|---|---|---|
| `mnemonic_sign_memory` | called inside `memory_capture` when signing enabled | Returns `attestationId` stored alongside memory |
| `mnemonic_recall` | supplements `memory_search` | Semantic recall from Mnemonik's own SQLite index |
| `mnemonic_verify` | called by `memory_verify` | COSE_Sign1 + optional Arweave/Solana check |
| `mnemonic_prove_identity` | — | Used for key handshake only |
| `mnemonic_whoami` | — | Server identity check |

## SDK Usage (TypeScript)

```typescript
import { MnemonicClient, LocalSigner, Keypair } from '@mnemonik-xyz/sdk';

const kp = Keypair.fromJSON(JSON.parse(process.env.MNEMONIC_IDENTITY!));
const client = new MnemonicClient({
  baseUrl: 'https://mcp.mnemonik.xyz',
  signer: new LocalSigner(kp),
  jwt: process.env.MNEMONIC_JWT,
});
client.setKeypair(kp);

// Sign a memory (local mode — free, SQLite only)
const { attestationId } = await client.signMemory(
  'content to remember',
  { tags: ['source:universal-memory'] }
);

// Recall semantically
const { hits } = await client.recall('what did I learn about X', { topK: 5 });

// Verify signature
const result = await client.verify(attestationId);
// { status: 'verified', signer: '<pubkey>', arweaveTx?, solanaTx? }
```

## Configuration

Add both MCP servers to your client config:

```json
{
  "mcpServers": {
    "universal-memory": {
      "command": "bun",
      "args": ["run", "/path/to/universal-memory/packages/memory-hub/src/mcp/server.ts"],
      "env": {
        "MEMORY_BACKEND": "local",
        "MNEMONIK_SIGNING": "true",
        "MNEMONIC_IDENTITY": "<keypair-json>",
        "MNEMONIC_JWT": "<your-jwt>"
      }
    },
    "mnemonik": {
      "url": "https://mcp.mnemonik.xyz/mcp",
      "headers": { "Authorization": "Bearer <your-jwt>" }
    }
  }
}
```

Or use only the hosted Mnemonik MCP if you don't need gbrain's synthesis layer:
```json
{
  "mcpServers": {
    "mnemonik": {
      "url": "https://mcp.mnemonik.xyz/mcp",
      "headers": { "Authorization": "Bearer <your-jwt>" }
    }
  }
}
```

## Write Modes

| Mode | Storage | Cost | Chain |
|---|---|---|---|
| `local` | SQLite only | Free | None |
| `participate` | SQLite + Arweave + Solana | Paid | Arweave (durable) + Solana (timestamp anchor) |

Source: `vendors/mnemonik/mcp/src/tools.rs`
