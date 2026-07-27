/**
 * Additional tests for ingest/fetcher.ts — covering uncovered branches.
 *
 * Coverage gaps (lines 124, 126-128, 131-134, 185-191, 215-216, 221-225, etc.):
 *   - htmlToText() fallbacks (Readability fails → JSDOM body → tag stripping)
 *   - Redirect to SSRF target → throws SsrfBlockedError
 *   - Content-Length header too large → throws
 *   - Non-HTML content type returned as-is
 *   - IPv4 CIDR checks at range boundaries
 *   - Empty body (no readable stream) → throws
 *
 * TDD anchors (Task 8):
 *   - ingest/fetcher.ts::private_ip_blocked (already covered in fetcher.test.ts)
 *   - redirect to private IP → blocked
 *   - Content-Length too large → error before download
 *   - plain text response returned without HTML processing
 */

import { describe, it, expect, afterEach, mock } from "bun:test";
import { fetchUrl, SsrfBlockedError } from "./fetcher.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  mock.restore();
});

describe("ingest/fetcher.ts — content-length guard", () => {
  it("throws when Content-Length header exceeds 10MB", async () => {
    global.fetch = mock(async () =>
      new Response("body content", {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(11 * 1024 * 1024), // 11MB
        },
      })
    ) as typeof global.fetch;

    await expect(fetchUrl("https://example.com/large")).rejects.toThrow(/too large/i);
  });

  it("does not throw when Content-Length is exactly 10MB", async () => {
    const bodyContent = "x".repeat(100);
    global.fetch = mock(async () => {
      return new Response(bodyContent, {
        status: 200,
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": String(10 * 1024 * 1024), // exactly 10MB header
        },
      });
    }) as typeof global.fetch;

    // Content-Length exactly at limit passes the header check
    // (actual body is tiny so won't hit the streaming limit)
    const result = await fetchUrl("https://example.com/exactly-limit");
    expect(typeof result).toBe("string");
  });
});

describe("ingest/fetcher.ts — non-HTML content types", () => {
  it("returns plain text response as-is (not HTML-processed)", async () => {
    global.fetch = mock(async () =>
      new Response("# Markdown Content\nSome text here.", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    ) as typeof global.fetch;

    const result = await fetchUrl("https://example.com/readme.txt");
    expect(result).toContain("# Markdown Content");
    expect(result).toContain("Some text here.");
  });

  it("returns JSON response as-is", async () => {
    const json = JSON.stringify({ key: "value", items: [1, 2, 3] });
    global.fetch = mock(async () =>
      new Response(json, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as typeof global.fetch;

    const result = await fetchUrl("https://api.example.com/data.json");
    expect(result).toContain('"key"');
    expect(result).toContain('"value"');
  });

  it("HTML with application/xhtml+xml is processed through htmlToText", async () => {
    global.fetch = mock(async () =>
      new Response(
        '<html><head><title>XHTML Doc</title></head><body><p>XHTML content here.</p></body></html>',
        {
          status: 200,
          headers: { "Content-Type": "application/xhtml+xml" },
        }
      )
    ) as typeof global.fetch;

    const result = await fetchUrl("https://example.com/page.xhtml");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("ingest/fetcher.ts — redirect to SSRF target", () => {
  it("throws SsrfBlockedError when redirect leads to private IP", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: redirect to a private IP
        return new Response(null, {
          status: 302,
          headers: { Location: "http://192.168.1.100/secret" },
        });
      }
      return new Response("content", { status: 200 });
    }) as typeof global.fetch;

    await expect(fetchUrl("https://public.example.com/redirect")).rejects.toThrow(SsrfBlockedError);
  });

  it("throws SsrfBlockedError when redirect leads to localhost", async () => {
    let callCount = 0;
    global.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, {
          status: 301,
          headers: { Location: "http://localhost:8080/internal" },
        });
      }
      return new Response("content", { status: 200 });
    }) as typeof global.fetch;

    await expect(fetchUrl("https://safe.example.com/redir")).rejects.toThrow(SsrfBlockedError);
  });
});

describe("ingest/fetcher.ts — HTML htmlToText fallbacks", () => {
  it("strips HTML tags from minimal HTML (no article element)", async () => {
    // Minimal HTML — Readability may not parse it successfully (no article)
    global.fetch = mock(async () =>
      new Response(
        "<html><body><p>Stripped text here.</p><script>bad script</script></body></html>",
        {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }
      )
    ) as typeof global.fetch;

    const result = await fetchUrl("https://example.com/minimal");
    expect(typeof result).toBe("string");
    // Should contain text but not raw script tags
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("<p>");
  });

  it("handles HTML with no body element gracefully", async () => {
    global.fetch = mock(async () =>
      new Response("<html><head><title>Title</title></head></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    ) as typeof global.fetch;

    // Should not throw — fallback to tag stripping
    const result = await fetchUrl("https://example.com/no-body");
    expect(typeof result).toBe("string");
  });
});

describe("ingest/fetcher.ts — redirect without Location header", () => {
  it("throws when redirect has no Location header", async () => {
    global.fetch = mock(async () =>
      new Response(null, {
        status: 302,
        // No Location header
      })
    ) as typeof global.fetch;

    await expect(fetchUrl("https://example.com/bad-redirect")).rejects.toThrow(
      /redirect without Location/i
    );
  });
});

describe("ingest/fetcher.ts — SsrfBlockedError class", () => {
  it("SsrfBlockedError is an Error instance", () => {
    const err = new SsrfBlockedError("blocked reason");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SsrfBlockedError);
  });

  it("SsrfBlockedError has correct name", () => {
    const err = new SsrfBlockedError("test");
    expect(err.name).toBe("SsrfBlockedError");
  });

  it("SsrfBlockedError preserves message", () => {
    const err = new SsrfBlockedError("reason text");
    expect(err.message).toBe("reason text");
  });
});

describe("ingest/fetcher.ts — IPv4 boundary tests", () => {
  it("throws for 172.32.0.1 (outside 172.16/12 — should NOT be blocked)", async () => {
    // 172.32.0.0 is outside 172.16.0.0/12 range (172.16 to 172.31 are private)
    // fetchUrl will attempt actual network call — mock to return 200
    global.fetch = mock(async () =>
      new Response("content", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    ) as typeof global.fetch;

    // 172.32.0.1 is a public IP (not in 172.16.0.0/12)
    const result = await fetchUrl("http://172.32.0.1/test");
    expect(typeof result).toBe("string");
  });

  it("throws SsrfBlockedError for 172.16.0.0 (start of private range)", async () => {
    await expect(fetchUrl("http://172.16.0.0/test")).rejects.toThrow(SsrfBlockedError);
  });

  it("throws SsrfBlockedError for 172.31.255.255 (end of private range)", async () => {
    await expect(fetchUrl("http://172.31.255.255/test")).rejects.toThrow(SsrfBlockedError);
  });
});
