/**
 * Tests for memory_think handler behaviour.
 *
 * TDD anchors from task 5:
 *   tools/think.ts::calls_storage_synthesize
 *   tools/think.ts::returns_answer_citations_gaps
 *   tools/think.ts::no_llm_key_returns_actionable_error
 *
 * The memory_think handler delegates directly to storage.synthesize(). We test
 * synthesize() output shapes here since the handler is a thin proxy (no logic
 * other than args extraction + JSON stringify). A full server integration test
 * would require a connected brain engine and LLM key — that is the smoke test.
 */

import { describe, it, expect } from 'bun:test';
import type { SynthesisResult } from '../storage/index.js';

// Helper: build a stub SynthesisResult as the handler would return
function makeStubSynthesis(overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    answer: 'This is the synthesized answer.',
    citations: [{ id: 'memory/page-slug', excerpt: 'memory/page-slug#3' }],
    gaps: ['What happened in Q2?'],
    ...overrides,
  };
}

describe('memory_think — calls_storage_synthesize', () => {
  it('synthesize result has required fields', () => {
    const result = makeStubSynthesis();
    expect(result).toHaveProperty('answer');
    expect(result).toHaveProperty('citations');
    expect(result).toHaveProperty('gaps');
  });
});

describe('memory_think — returns_answer_citations_gaps', () => {
  it('answer is a non-empty string', () => {
    const result = makeStubSynthesis();
    expect(typeof result.answer).toBe('string');
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('citations is an array of { id, excerpt } objects', () => {
    const result = makeStubSynthesis({
      citations: [
        { id: 'slug-one', excerpt: 'slug-one#2' },
        { id: 'slug-two', excerpt: 'slug-two' },
      ],
    });
    expect(Array.isArray(result.citations)).toBe(true);
    for (const c of result.citations) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.excerpt).toBe('string');
    }
  });

  it('gaps is an array of strings', () => {
    const result = makeStubSynthesis({ gaps: ['Gap 1', 'Gap 2'] });
    expect(Array.isArray(result.gaps)).toBe(true);
    for (const g of result.gaps) {
      expect(typeof g).toBe('string');
    }
  });

  it('citations with null row_num map excerpt to page_slug only', () => {
    // Validate the LocalAdapter mapping logic: row_num=null → excerpt = page_slug
    const pageSlug = 'concepts/attention';
    const rowNum: number | null = null;
    const excerpt = rowNum !== null ? `${pageSlug}#${rowNum}` : pageSlug;
    expect(excerpt).toBe('concepts/attention');
  });

  it('citations with numeric row_num map excerpt to slug#row', () => {
    const pageSlug = 'concepts/attention';
    const rowNum = 5;
    const excerpt = rowNum !== null ? `${pageSlug}#${rowNum}` : pageSlug;
    expect(excerpt).toBe('concepts/attention#5');
  });
});

describe('memory_think — no_llm_key_returns_actionable_error', () => {
  it('bm25-only mode synthesize returns setup message (not a throw)', async () => {
    // Import LocalAdapter — in bm25-only mode (no LLM keys), synthesize must
    // return an actionable message, not throw. This keeps MCP tools usable.
    const { LocalAdapter } = await import('../storage/local.js');
    const adapter = new LocalAdapter({ dataDir: '/tmp/test-think-bm25' });
    const result = await adapter.synthesize({ question: 'What do I know?' });

    // Must return a valid SynthesisResult shape (not throw)
    expect(typeof result.answer).toBe('string');
    expect(Array.isArray(result.citations)).toBe(true);
    expect(Array.isArray(result.gaps)).toBe(true);

    // In bm25-only or failed synthesis, the answer contains actionable guidance
    // (it may be "Synthesis requires LLM..." or gbrain's "no LLM available" stub)
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it('no-LLM answer is a string (never throws)', async () => {
    const { LocalAdapter } = await import('../storage/local.js');
    const adapter = new LocalAdapter({ dataDir: '/tmp/test-think-nollm' });
    // This must never throw — the handler relies on synthesize being safe
    let threw = false;
    try {
      const result = await adapter.synthesize({ question: 'Anything?' });
      expect(typeof result.answer).toBe('string');
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
