/**
 * MnemonikAdapter — real integration with @mnemonik-xyz/sdk.
 *
 * Source: vendors/mnemonik/packages/sdk
 * Hosted MCP: https://mcp.mnemonik.xyz/mcp
 *
 * Write modes:
 *   local       — SQLite only, Ed25519 signed, free, no chain
 *   participate — SQLite + Arweave (durable) + Solana anchor (tamper-proof timestamp), paid
 *
 * Auth: JWT from OAuth 2.1 + PKCE flow via mnemonik.xyz/install
 * For headless/agent use: set MNEMONIC_JWT + MNEMONIC_IDENTITY env vars.
 */

import {
  MnemonicClient,
  LocalSigner,
  Keypair,
  parseJwtPayload,
  type SignMemoryResult,
  type VerifyResult,
  type RecallHit,
} from "@mnemonik-xyz/sdk";

export interface MnemonikConfig {
  baseUrl?: string;
  jwt?: string;
  identityJson?: string;
  mode?: "local" | "participate";
}

export class MnemonikAdapter {
  private client: MnemonicClient;
  private mode: "local" | "participate";

  constructor(config: MnemonikConfig = {}) {
    const baseUrl = config.baseUrl ?? process.env.MNEMONIC_BASE_URL ?? "https://mcp.mnemonik.xyz";
    const jwt = config.jwt ?? process.env.MNEMONIC_JWT;
    const identityJson = config.identityJson ?? process.env.MNEMONIC_IDENTITY;
    this.mode = config.mode ?? (process.env.MNEMONIC_MODE as "local" | "participate") ?? "local";

    if (!identityJson) {
      throw new Error("Mnemonik: MNEMONIC_IDENTITY env var required (keypair JSON)");
    }
    if (!jwt) {
      throw new Error("Mnemonik: MNEMONIC_JWT env var required — run `npx @mnemonik-xyz/cli login`");
    }

    // Validate JWT is not expired before constructing the client
    parseJwtPayload(jwt); // throws AuthError if expired or malformed

    const kp = Keypair.fromJSON(JSON.parse(identityJson));
    const signer = new LocalSigner(kp);

    this.client = new MnemonicClient({ baseUrl, signer, jwt });
    this.client.setKeypair(kp);
  }

  /**
   * Sign a memory with Mnemonik.
   * Returns attestationId to store alongside the memory entry in gbrain.
   */
  async sign(content: string, tags: string[] = []): Promise<SignMemoryResult> {
    return this.client.signMemory(content, { tags, mode: this.mode } as any);
  }

  /**
   * Verify a previously signed memory by its attestationId.
   * Checks COSE_Sign1 signature; in participate mode also checks Arweave/Solana.
   */
  async verify(attestationId: string): Promise<VerifyResult> {
    return this.client.verify(attestationId);
  }

  /**
   * Semantic recall directly from Mnemonik's SQLite index.
   * Supplements gbrain's hybrid search with Mnemonik-native recall.
   */
  async recall(query: string, topK = 5): Promise<RecallHit[]> {
    const result = await this.client.recall(query, { topK });
    return result.hits;
  }
}
