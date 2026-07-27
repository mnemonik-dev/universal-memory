/**
 * Universal Memory Hub setup CLI.
 *
 * Probes Ollama and prints setup guidance to help users configure their
 * preferred LLM backend. Invoked via `bun run src/setup.ts` or
 * `bunx universal-memory setup`.
 *
 * Always exits 0 — this is a guidance script, not a validation gate.
 */

const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  const ollamaReachable = await probeOllama();

  if (ollamaReachable) {
    console.log(`Ollama detected at ${OLLAMA_BASE}. Add to your shell:`);
    console.log(`  export OLLAMA_BASE_URL=${OLLAMA_BASE}`);
    console.log('');
    console.log('Then pull a model (e.g.):');
    console.log('  ollama pull llama3.2');
    console.log('  ollama pull nomic-embed-text');
  } else {
    console.log('Optional: install Ollama for local semantic embeddings (no API key needed):');
    console.log('  https://ollama.com');
  }

  console.log('');
  console.log('For cloud LLM: set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY');
}

await main();
