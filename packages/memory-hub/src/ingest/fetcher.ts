/**
 * ingest/fetcher.ts — URL fetch with SSRF mitigations
 *
 * Security decisions (D11):
 * - Blocks file://, ftp:// and other non-http(s) schemes
 * - Blocks loopback: 127.0.0.1, 127.x.x.x, ::1, localhost
 * - Blocks private IP ranges: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local)
 * - Enforces max 3 redirects manually (no silent following)
 * - Enforces 30s timeout
 * - Content-size guard: refuses body > 10MB
 *
 * Returns markdown-ified content using @mozilla/readability for HTML pages.
 */

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

/** Max redirects before aborting (D11). */
const MAX_REDIRECTS = 3;

/** Request timeout in milliseconds (D11). */
const FETCH_TIMEOUT_MS = 30_000;

/** Max response body to read (10MB — D8). */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * SSRF block error — thrown when a URL is blocked by the allowlist policy.
 */
export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SsrfBlockedError";
  }
}

/**
 * Parse an IP address string to its numeric octets.
 * Returns null if the string is not a valid IPv4 address.
 */
function parseIPv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums as [number, number, number, number];
}

/**
 * Check whether a parsed IPv4 address falls within a CIDR block.
 */
function ipv4InCidr(
  ip: [number, number, number, number],
  cidrBase: [number, number, number, number],
  prefixLen: number
): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  const ipNum =
    (((ip[0] * 256 + ip[1]) * 256 + ip[2]) * 256 + ip[3]) >>> 0;
  const baseNum =
    (((cidrBase[0] * 256 + cidrBase[1]) * 256 + cidrBase[2]) * 256 +
      cidrBase[3]) >>>
    0;
  return (ipNum & mask) === (baseNum & mask);
}

/**
 * Validate a URL against the SSRF denylist. Throws SsrfBlockedError if blocked.
 *
 * Blocked:
 * - Non-http(s) schemes (file://, ftp://, etc.)
 * - Loopback: 127.x.x.x, ::1, localhost
 * - Private ranges: 10/8, 172.16/12, 192.168/16, 169.254/16
 */
function validateSsrf(url: URL): void {
  const scheme = url.protocol; // e.g. "http:", "file:"

  if (scheme !== "http:" && scheme !== "https:") {
    throw new SsrfBlockedError(
      `Blocked scheme: ${scheme.replace(":", "://")} — only http:// and https:// are allowed`
    );
  }

  const hostname = url.hostname.toLowerCase();

  // IPv6 loopback
  if (hostname === "::1" || hostname === "[::1]") {
    throw new SsrfBlockedError(
      `Blocked loopback address: ${hostname}`
    );
  }

  // Hostname-based loopback
  if (hostname === "localhost") {
    throw new SsrfBlockedError(
      `Blocked loopback hostname: localhost`
    );
  }

  // IPv4 checks
  const ipv4 = parseIPv4(hostname);
  if (ipv4 !== null) {
    // 127.0.0.0/8 — full loopback range
    if (ipv4InCidr(ipv4, [127, 0, 0, 0], 8)) {
      throw new SsrfBlockedError(
        `Blocked loopback address: ${hostname} (127.0.0.0/8)`
      );
    }
    // 10.0.0.0/8 — private
    if (ipv4InCidr(ipv4, [10, 0, 0, 0], 8)) {
      throw new SsrfBlockedError(
        `Blocked private IP: ${hostname} (10.0.0.0/8)`
      );
    }
    // 172.16.0.0/12 — private
    if (ipv4InCidr(ipv4, [172, 16, 0, 0], 12)) {
      throw new SsrfBlockedError(
        `Blocked private IP: ${hostname} (172.16.0.0/12)`
      );
    }
    // 192.168.0.0/16 — private
    if (ipv4InCidr(ipv4, [192, 168, 0, 0], 16)) {
      throw new SsrfBlockedError(
        `Blocked private IP: ${hostname} (192.168.0.0/16)`
      );
    }
    // 169.254.0.0/16 — link-local (AWS metadata, etc.)
    if (ipv4InCidr(ipv4, [169, 254, 0, 0], 16)) {
      throw new SsrfBlockedError(
        `Blocked link-local address: ${hostname} (169.254.0.0/16)`
      );
    }
  }
}

/**
 * Convert HTML content to readable markdown-ish text using @mozilla/readability.
 * Falls back to raw text extraction if Readability fails.
 */
function htmlToText(html: string, url: string): string {
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (article && article.textContent) {
      // Build a simple markdown-ish output: title + text content
      const parts: string[] = [];
      if (article.title) {
        parts.push(`# ${article.title}`);
        parts.push("");
      }
      parts.push(article.textContent.trim());
      return parts.join("\n");
    }
  } catch {
    // Readability parse failed — fall through to plain text extraction
  }

  // Fallback: strip tags and return raw text via JSDOM
  try {
    const dom = new JSDOM(html);
    return dom.window.document.body?.textContent?.trim() ?? html;
  } catch {
    return html;
  }
}

/**
 * Fetch a URL and return its text content (HTML → readable text/markdown).
 *
 * Enforces SSRF mitigations (D11):
 * - Blocks blocked schemes and private IPs before making any network request.
 * - Manually follows up to 3 redirects (throws on the 4th).
 * - Timeout: 30 seconds.
 * - Body size: 10MB max.
 *
 * @param rawUrl - The URL string to fetch.
 * @returns Extracted text content (markdown-ified for HTML responses).
 */
export async function fetchUrl(rawUrl: string): Promise<string> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  // SSRF check BEFORE any network call
  validateSsrf(parsedUrl);

  let currentUrl = rawUrl;
  let redirectsFollowed = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        // Use "manual" redirect mode so we can count and validate redirects ourselves
        redirect: "manual",
        headers: {
          "User-Agent": "universal-memory-hub/1.0 (+https://github.com/mnemonik-dev/universal-memory)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Handle redirects manually
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`HTTP ${response.status}: redirect without Location header`);
      }

      if (redirectsFollowed >= MAX_REDIRECTS) {
        throw new Error(
          `Too many redirects (max ${MAX_REDIRECTS}) fetching ${rawUrl}. Last redirect to: ${location}`
        );
      }

      // Resolve relative redirects
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, currentUrl);
      } catch {
        throw new Error(`Invalid redirect URL: ${location}`);
      }

      // SSRF-check the redirect target too (prevents open redirect → SSRF)
      validateSsrf(redirectUrl);

      currentUrl = redirectUrl.toString();
      redirectsFollowed++;
      continue;
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} fetching ${rawUrl}: ${response.statusText}`
      );
    }

    // Guard body size — read with a size cap to avoid OOM
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
      throw new Error(
        `Response too large (Content-Length: ${contentLength} bytes, max ${MAX_BODY_BYTES})`
      );
    }

    // Read body with size guard
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error(`No response body for ${rawUrl}`);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.length;
        if (totalBytes > MAX_BODY_BYTES) {
          reader.cancel().catch(() => {});
          throw new Error(
            `Response body too large (> ${MAX_BODY_BYTES} bytes) fetching ${rawUrl}`
          );
        }
        chunks.push(value);
      }
    }

    const bodyBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bodyBytes.set(chunk, offset);
      offset += chunk.length;
    }
    const bodyText = new TextDecoder().decode(bodyBytes);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      return htmlToText(bodyText, currentUrl);
    }

    // For non-HTML (plain text, markdown, JSON, etc.), return as-is
    return bodyText;
  }
}
