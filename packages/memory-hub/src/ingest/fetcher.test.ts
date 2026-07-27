/**
 * Tests for ingest/fetcher.ts — URL fetch with SSRF mitigations
 *
 * TDD anchors from task 3:
 *   - valid_url_returns_markdown
 *   - file_scheme_blocked (SSRF: file://)
 *   - localhost_blocked (SSRF: 127.0.0.1)
 *   - private_ip_blocked (SSRF: 10.0.0.1)
 *   - non_200_throws
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { fetchUrl, SsrfBlockedError } from "./fetcher.js";

// Store original global.fetch
const originalFetch = global.fetch;

describe("ingest/fetcher.ts", () => {
  afterEach(() => {
    // Restore global fetch after each test
    global.fetch = originalFetch;
    mock.restore();
  });

  describe("valid_url_returns_markdown", () => {
    it("fetches a valid URL and returns text content", async () => {
      // Mock fetch to return simple HTML
      global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        return new Response(
          "<html><head><title>Test Article</title></head><body><article><p>Hello world content here.</p></article></body></html>",
          {
            status: 200,
            headers: { "Content-Type": "text/html" },
          }
        );
      }) as typeof global.fetch;

      const result = await fetchUrl("https://example.com/article");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("returns extracted text from HTML (not raw HTML tags)", async () => {
      global.fetch = mock(async () =>
        new Response(
          `<html><head><title>My Article</title></head><body>
            <article>
              <h1>Main Heading</h1>
              <p>This is the main content paragraph.</p>
            </article>
          </body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } }
        )
      ) as typeof global.fetch;

      const result = await fetchUrl("https://example.com");
      // Should contain text content
      expect(result).toContain("Main Heading");
    });
  });

  describe("file_scheme_blocked", () => {
    it("throws SsrfBlockedError for file:// scheme", async () => {
      await expect(fetchUrl("file:///etc/passwd")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for ftp:// scheme", async () => {
      await expect(fetchUrl("ftp://example.com/file")).rejects.toThrow(SsrfBlockedError);
    });

    it("SsrfBlockedError contains scheme in message for file://", async () => {
      try {
        await fetchUrl("file:///etc/passwd");
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SsrfBlockedError);
        expect((e as SsrfBlockedError).message).toContain("file://");
      }
    });
  });

  describe("localhost_blocked", () => {
    it("throws SsrfBlockedError for 127.0.0.1", async () => {
      await expect(fetchUrl("http://127.0.0.1/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for localhost hostname", async () => {
      await expect(fetchUrl("http://localhost/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for ::1 (IPv6 loopback)", async () => {
      await expect(fetchUrl("http://[::1]/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for fc00:: (IPv6 ULA private range fc00::/7)", async () => {
      await expect(fetchUrl("http://[fc00::1]/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for fd00:: (IPv6 ULA private range fd00::/8 within fc00::/7)", async () => {
      await expect(fetchUrl("http://[fd00::1]/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for fe80:: (IPv6 link-local fe80::/10)", async () => {
      await expect(fetchUrl("http://[fe80::1]/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for 127.x.x.x range", async () => {
      await expect(fetchUrl("http://127.0.0.2/api")).rejects.toThrow(SsrfBlockedError);
    });
  });

  describe("private_ip_blocked", () => {
    it("throws SsrfBlockedError for 10.0.0.1 (10/8 range)", async () => {
      await expect(fetchUrl("http://10.0.0.1/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for 10.255.255.255 (10/8 range end)", async () => {
      await expect(fetchUrl("http://10.255.255.255/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for 192.168.1.1 (192.168/16 range)", async () => {
      await expect(fetchUrl("http://192.168.1.1/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for 172.16.0.1 (172.16/12 range)", async () => {
      await expect(fetchUrl("http://172.16.0.1/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for 172.31.255.255 (172.16/12 range end)", async () => {
      await expect(fetchUrl("http://172.31.255.255/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("throws SsrfBlockedError for 169.254.0.1 (link-local range)", async () => {
      await expect(fetchUrl("http://169.254.0.1/api")).rejects.toThrow(SsrfBlockedError);
    });

    it("does NOT block public IPs like 8.8.8.8", async () => {
      // 8.8.8.8 is a public IP — blocking should not throw on scheme/IP check
      // (fetch itself may fail in test env, but not from SSRF check)
      global.fetch = mock(async () =>
        new Response("<html><body><p>Content</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      ) as typeof global.fetch;

      // Should not throw SsrfBlockedError
      const result = await fetchUrl("http://8.8.8.8/");
      expect(typeof result).toBe("string");
    });
  });

  describe("non_200_throws", () => {
    it("throws on 404 response", async () => {
      global.fetch = mock(async () =>
        new Response("Not Found", { status: 404 })
      ) as typeof global.fetch;

      await expect(fetchUrl("https://example.com/missing")).rejects.toThrow();
    });

    it("throws on 500 response", async () => {
      global.fetch = mock(async () =>
        new Response("Internal Server Error", { status: 500 })
      ) as typeof global.fetch;

      await expect(fetchUrl("https://example.com/error")).rejects.toThrow();
    });

    it("error message includes status code", async () => {
      global.fetch = mock(async () =>
        new Response("Not Found", { status: 404 })
      ) as typeof global.fetch;

      try {
        await fetchUrl("https://example.com/missing");
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as Error).message).toContain("404");
      }
    });

    it("throws on redirect limit exceeded (> 3 redirects)", async () => {
      let callCount = 0;
      // fetchUrl follows redirects manually with redirect: 'manual'.
      // Each 302 increments redirectsFollowed. On the 4th redirect attempt
      // (redirectsFollowed === 3 === MAX_REDIRECTS), it throws before fetching.
      // So mock returns 302 for calls 1–3 (redirectsFollowed goes 0→1→2→3),
      // and the 4th redirect triggers the throw — the mock's 4th return is never reached.
      global.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
        callCount++;
        return new Response(null, {
          status: 302,
          headers: { "Location": "https://example.com/next" },
        });
      }) as typeof global.fetch;

      await expect(fetchUrl("https://example.com/redirect")).rejects.toThrow(/redirect/i);
    });
  });
});
