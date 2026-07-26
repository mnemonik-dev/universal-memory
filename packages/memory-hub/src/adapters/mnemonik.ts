/**
 * MnemonikAdapter — bridges universal-memory with the Mnemonik protocol.
 *
 * Mnemonik protocol: https://github.com/mnemon-dev/mnemon
 * - Ed25519 keypairs for signing memories
 * - COSE_Sign1 payload format
 * - Solana SPL Memo for on-chain timestamping
 * - Cross-device recall via semantic similarity
 *
 * When MNEMONIK_SIGNING=true, every memory_capture can optionally be signed.
 * Signed memories can be verified by anyone with the pubkey.
 */

interface MnemonikConfig {
  pubkey?: string;
  apiUrl?: string;
}

interface SignResult {
  memory_id: string;
  signature: string;
  pubkey: string;
  cose_payload: string;
  solana_tx?: string;
  timestamp: string;
}

interface VerifyResult {
  memory_id: string;
  valid: boolean;
  pubkey: string;
  signed_at: string;
  solana_tx?: string;
  tampered: boolean;
}

export class MnemonikAdapter {
  private pubkey: string;
  private apiUrl: string;

  constructor(config: MnemonikConfig = {}) {
    this.pubkey = config.pubkey ?? process.env.MNEMONIK_PUBKEY ?? "";
    this.apiUrl = config.apiUrl ?? process.env.MNEMONIK_API_URL ?? "https://mnemonik.xyz/api";
  }

  async sign(memoryId: string, opts: { anchor?: boolean } = {}): Promise<SignResult> {
    // In production: call Mnemonik's MCP tool `mnemonic_sign_memory`
    // which prompts browser-based approval (private key never leaves device)
    //
    // For now: stub that returns the expected shape so consumers can integrate
    const response = await fetch(`${this.apiUrl}/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memory_id: memoryId,
        pubkey: this.pubkey,
        anchor_to_solana: opts.anchor ?? false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Mnemonik sign failed: ${response.statusText}`);
    }

    return response.json() as Promise<SignResult>;
  }

  async verify(memoryId: string): Promise<VerifyResult> {
    const response = await fetch(`${this.apiUrl}/verify/${memoryId}`);

    if (!response.ok) {
      throw new Error(`Mnemonik verify failed: ${response.statusText}`);
    }

    return response.json() as Promise<VerifyResult>;
  }
}
