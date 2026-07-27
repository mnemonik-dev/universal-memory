/**
 * End-to-end MCP smoke test.
 *
 * Spawns the REAL universal-memory stdio server and drives
 * capture -> list -> search -> think through the MCP protocol against a
 * throwaway PGLite data dir. This is the gate the mock-based unit tests do
 * NOT provide: it exercises the real gbrain engine, so an adapter that calls
 * a non-existent engine method fails HERE (unlike the unit tests).
 *
 * Run:  bun run scripts/mcp-smoke.ts     (from packages/memory-hub)
 * Needs: ANTHROPIC_API_KEY (or OPENAI_API_KEY) for the memory_think step;
 *        capture/search/list work in BM25-only mode without a key.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const HUB = resolve(import.meta.dir, "..");
const SDK = `${HUB}/node_modules/@modelcontextprotocol/sdk/dist/esm/client`;
const { Client } = await import(`${SDK}/index.js`);
const { StdioClientTransport } = await import(`${SDK}/stdio.js`);

const DATA_DIR = mkdtempSync(join(tmpdir(), "um-smoke-"));

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", `${HUB}/src/mcp/server.ts`],
  cwd: HUB,
  env: { ...process.env, MEMORY_BACKEND: "local", MEMORY_GIT_DIR: DATA_DIR },
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const parse = (r: any) => {
  const t = r?.content?.[0]?.text;
  try { return JSON.parse(t); } catch { return t; }
};
const call = (name: string, args: any) => client.callTool({ name, arguments: args });

let failed = false;
try {
  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t: any) => t.name).join(", "));

  const facts = [
    "The Universal Memory Hub stores data locally in PGLite, an embedded Postgres compiled to WASM that needs no server.",
    "gbrain performs hybrid search combining vector similarity, BM25 keyword matching, and Reciprocal Rank Fusion (RRF).",
    "The memory_sign tool produces Ed25519 COSE_Sign1 signatures via the Mnemonik protocol for verifiable memories.",
  ];

  console.log("\n--- CAPTURE ---");
  for (const content of facts) {
    console.log("captured:", JSON.stringify(parse(await call("memory_capture", { content, source: "smoke", tags: ["smoke"] }))));
  }

  console.log("\n--- LIST ---");
  console.log(JSON.stringify(parse(await call("memory_list", { limit: 10 })), null, 1));

  console.log("\n--- SEARCH: 'how are results ranked?' ---");
  console.log(JSON.stringify(parse(await call("memory_search", { query: "how are search results ranked?", top_k: 3 })), null, 1));

  console.log("\n--- THINK ---");
  console.log(JSON.stringify(parse(await call("memory_think", {
    question: "What does the Universal Memory Hub use for local storage, and how does it rank search results?",
  })), null, 1));

  console.log("\nDONE");
} catch (e) {
  failed = true;
  console.error("\nSMOKE FAILED:", (e as Error).message);
} finally {
  await client.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
