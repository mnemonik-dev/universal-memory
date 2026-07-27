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
 *
 * Use `createMnemonikAdapter()` factory instead of `new MnemonikAdapter()` in
 * application code — the factory returns null and logs a warning on JWT expiry
 * or missing credentials rather than crashing at startup.
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

/**
 * Factory that creates a MnemonikAdapter or returns null with a startup
 * warning on any configuration / credential error.
 *
 * Motivation: the class constructor throws on expired JWT or missing env vars,
 * which would crash the MCP server at startup. By using this factory the
 * server starts cleanly and individual tool calls receive a descriptive error
 * instead of a process crash.
 *
 * Per-call JWT expiry: the JWT is validated once here. If it has already
 * expired at startup the caller receives null. JWTs that expire after server
 * start are not re-checked here — the SDK will throw AuthError on the next
 * network call, which the tool handler translates into an actionable error.
 */
export function createMnemonikAdapter(
  overrides: { jwt?: string; identityJson?: string; mode?: "local" | "participate"; baseUrl?: string } = {}
): MnemonikAdapter | null {
  const jwt = overrides.jwt ?? process.env.MNEMONIC_JWT;
  const identityJson = overrides.identityJson ?? process.env.MNEMONIC_IDENTITY;
  const mode = overrides.mode ?? (process.env.MNEMONIC_MODE as "local" | "participate") ?? "local";
  const baseUrl = overrides.baseUrl ?? process.env.MNEMONIC_BASE_URL ?? "https://mcp.mnemonik.xyz";

  if (!jwt) {
    process.stderr.write(
      "[universal-memory] WARNING: MNEMONIC_JWT not set — Mnemonik signing disabled. " +
      "Run `npx @mnemonik-xyz/cli login` to obtain a JWT.\n"
    );
    return null;
  }
  if (!identityJson) {
    process.stderr.write(
      "[universal-memory] WARNING: MNEMONIC_IDENTITY not set — Mnemonik signing disabled. " +
      "Run `npx @mnemonik-xyz/cli init` to create a keypair.\n"
    );
    return null;
  }

  try {
    return new MnemonikAdapter({ jwt, identityJson, mode, baseUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[universal-memory] WARNING: Mnemonik JWT expired or invalid — signing disabled. ` +
      `Renew with \`npx @mnemonik-xyz/cli login\`. Details: ${msg}\n`
    );
    return null;
  }
}
