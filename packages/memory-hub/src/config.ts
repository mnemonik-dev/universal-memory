/**
 * config.ts — Universal Memory Hub runtime configuration.
 *
 * Runs module-level side effects to detect available LLM providers and
 * configure the gbrain AI gateway. Priority order:
 *   1. Cloud API keys: OPENAI_API_KEY → ANTHROPIC_API_KEY → GOOGLE_API_KEY
 *   2. Ollama at OLLAMA_BASE_URL (default localhost:11434)
 *   3. BM25-only fallback — semantic search disabled, synthesis returns setup hint
 *
 * MCP note: this module writes warnings to stderr (not stdout) because the
 * MCP server uses stdout for JSON-RPC framing.
 *
 * DEV-1 resolution: BM25-only mode lets the server start without any config,
 * satisfying the zero-configuration local-mode requirement.
 */

import { configureGateway } from 'gbrain/ai/gateway';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Secret scrubbing ────────────────────────────────────────────────────────

/**
 * Scrub secrets from log strings. Not a security boundary — a log hygiene
 * helper. Covers Bearer tokens, sk-... API key patterns, and JSON keypair/jwt
 * field values. Exported for reuse in other modules (D13).
 */
export function scrubSecrets(s: string): string {
  return s
    // Redact Bearer tokens: "Bearer <token>" → "Bearer [REDACTED]"
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
    // Redact Anthropic API keys: sk-ant-api<NN>-... (MEDIUM-3 fix)
    .replace(/\bsk-ant-api\d\d-[A-Za-z0-9\-_]{10,}/g, 'sk-ant-[REDACTED]')
    // Redact sk-... API key patterns (OpenAI style — must come AFTER Anthropic pattern
    // because Anthropic keys also start with sk- and the more-specific pattern fires first)
    .replace(/\bsk-[A-Za-z0-9\-_]{4,}/g, 'sk-[REDACTED]')
    // Redact Google API keys: AIza<35 chars> (MEDIUM-3 fix)
    .replace(/\bAIza[A-Za-z0-9\-_]{35}/g, 'AIza[REDACTED]')
    // Redact Postgres/PostgreSQL DSN passwords: postgres://user:PASSWORD@host (MEDIUM-3 fix)
    .replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/g, '$1[REDACTED]$3')
    // Redact JSON keypair field values
    .replace(/"keypair"\s*:\s*"[^"]*"/g, '"keypair":"[REDACTED]"')
    // Redact JSON jwt field values
    .replace(/"jwt"\s*:\s*"[^"]*"/g, '"jwt":"[REDACTED]"');
}

/** Show only the last 4 characters of an API key for log display. */
function maskKey(key: string): string {
  if (key.length <= 4) return '****';
  return key.slice(0, 3).replace(/./g, '*') + '...' + key.slice(-4);
}

// ─── Data directory ──────────────────────────────────────────────────────────

function resolveDataDir(): string {
  const raw = process.env.MEMORY_DATA_DIR;
  if (raw) {
    // Expand leading ~ to home directory
    if (raw.startsWith('~')) {
      return join(homedir(), raw.slice(1));
    }
    return raw;
  }
  return join(homedir(), '.universal-memory', 'brain');
}

/** Resolved data directory (with ~ expanded). */
export const dataDir: string = resolveDataDir();

// ─── Mode detection ──────────────────────────────────────────────────────────

export type Mode = 'full' | 'ollama' | 'bm25-only';

interface ResolvedConfig {
  mode: Mode;
  dataDir: string;
  provider?: string;
  ollamaBaseUrl?: string;
}

// Module-level config — resolved once at startup.
let _resolvedConfig: ResolvedConfig = {
  mode: 'bm25-only',
  dataDir,
};

// Guard: configureGateway should only be called once.
let _gatewayConfigured = false;

/**
 * Probe Ollama. Returns true when the Ollama API is reachable at the given base URL.
 * Uses a 2-second timeout so we don't block server startup.
 */
async function probeOllama(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Configure the AI gateway and set the operating mode. Called once at module
 * load. Returns the resolved config for callers who need to inspect it.
 */
async function initConfig(): Promise<ResolvedConfig> {
  const ollamaBase = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

  // Priority 1: Cloud API keys
  const openaiKey = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const googleKey = process.env.GOOGLE_API_KEY;

  if (openaiKey) {
    if (!_gatewayConfigured) {
      configureGateway({
        embedding_model: 'openai:text-embedding-3-small',
        chat_model: 'openai:gpt-4o',
        expansion_model: 'openai:gpt-4o-mini',
        env: { ...process.env as Record<string, string> },
      });
      _gatewayConfigured = true;
    }
    process.stderr.write(
      `[universal-memory] AI gateway configured: provider=openai, key=${maskKey(openaiKey)}\n`
    );
    return { mode: 'full', dataDir, provider: 'openai' };
  }

  if (anthropicKey) {
    if (!_gatewayConfigured) {
      configureGateway({
        chat_model: 'anthropic:claude-haiku-4-5-20251001',
        expansion_model: 'anthropic:claude-haiku-4-5-20251001',
        env: { ...process.env as Record<string, string> },
      });
      _gatewayConfigured = true;
    }
    process.stderr.write(
      `[universal-memory] AI gateway configured: provider=anthropic, key=${maskKey(anthropicKey)}\n`
    );
    return { mode: 'full', dataDir, provider: 'anthropic' };
  }

  if (googleKey) {
    if (!_gatewayConfigured) {
      configureGateway({
        embedding_model: 'google:text-embedding-004',
        chat_model: 'google:gemini-2.0-flash-001',
        expansion_model: 'google:gemini-2.0-flash-001',
        env: { ...process.env as Record<string, string> },
      });
      _gatewayConfigured = true;
    }
    process.stderr.write(
      `[universal-memory] AI gateway configured: provider=google, key=${maskKey(googleKey)}\n`
    );
    return { mode: 'full', dataDir, provider: 'google' };
  }

  // Priority 2: Ollama
  const ollamaReachable = await probeOllama(ollamaBase);
  if (ollamaReachable) {
    if (!_gatewayConfigured) {
      configureGateway({
        embedding_model: 'ollama:nomic-embed-text',
        chat_model: 'ollama:llama3.2',
        expansion_model: 'ollama:llama3.2',
        base_urls: { ollama: ollamaBase },
        env: {
          ...process.env as Record<string, string>,
          OLLAMA_BASE_URL: ollamaBase,
        },
      });
      _gatewayConfigured = true;
    }
    process.stderr.write(
      `[universal-memory] AI gateway configured: provider=ollama, baseUrl=${ollamaBase}\n`
    );
    return { mode: 'ollama', dataDir, provider: 'ollama', ollamaBaseUrl: ollamaBase };
  }

  // Priority 3: BM25-only fallback
  process.stderr.write(
    `[universal-memory] Running in BM25-only mode. For semantic search, set OPENAI_API_KEY or run setup.\n`
  );
  return { mode: 'bm25-only', dataDir };
}

// ─── Module-level init ───────────────────────────────────────────────────────

// Run config init at module load. The top-level await is resolved when the
// module is first imported. Subsequent imports get the cached module.
const _initPromise = initConfig().then(cfg => {
  _resolvedConfig = cfg;
}).catch(err => {
  // If init fails, fall back to bm25-only and don't crash the server.
  process.stderr.write(
    `[universal-memory] Config init failed (${err?.message ?? err}), falling back to BM25-only mode.\n`
  );
  _resolvedConfig = { mode: 'bm25-only', dataDir };
});

// Wait for config init to complete. Top-level await in ES modules.
await _initPromise;

/** The operating mode determined at startup. */
export const mode: Mode = _resolvedConfig.mode;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return the resolved config object. Useful for testing and for modules that
 * need to inspect the current operating mode without re-running side effects.
 */
export function getConfig(): ResolvedConfig {
  return { ..._resolvedConfig };
}
