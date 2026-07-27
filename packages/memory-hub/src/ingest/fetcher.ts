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
 * Check whether a compressed IPv6 hex group prefix matches a /N block.
 * This is a simplified check: we parse the raw hex string and compare the top N bits.
 * Only works for well-formed IPv6 addresses without elision on the relevant prefix bits.
 */
function ipv6HasPrefix(hostname: string, prefixHex: string, prefixBits: number): boolean {
  // Normalize: strip brackets and lowercase
  const raw = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Only check the leading bytes that the prefix covers
  const hexCharsNeeded = Math.ceil(prefixBits / 4);
  const rawCompact = raw.replace(/:/g, "");
  const prefixCompact = prefixHex.replace(/:/g, "");
  if (rawCompact.length < hexCharsNeeded || prefixCompact.length < hexCharsNeeded) return false;
  const rawPrefix = rawCompact.slice(0, hexCharsNeeded);
  const expectedPrefix = prefixCompact.slice(0, hexCharsNeeded);
  // For exact nibble boundaries this is sufficient; partial last nibble is rare for /7, /10
  return rawPrefix.startsWith(expectedPrefix.slice(0, Math.floor(prefixBits / 4)));
}

/**
 * Validate a URL against the SSRF denylist. Throws SsrfBlockedError if blocked.
 *
 * Blocked:
 * - Non-http(s) schemes (file://, ftp://, etc.)
 * - Loopback: 127.x.x.x, ::1, localhost
 * - Private IPv4 ranges: 10/8, 172.16/12, 192.168/16, 169.254/16
 * - Private IPv6 ranges: ::1 (loopback), fc00::/7 (ULA), fe80::/10 (link-local)
 *
 * LIMITATION — DNS rebinding: this check validates the hostname/IP at call time.
 * If a public hostname resolves to a private IP at request time (DNS rebinding),
 * this check is bypassed. Production deployments MUST use a network-level egress
 * firewall (e.g. iptables DROP for RFC1918 ranges) as the authoritative mitigation.
 * This pre-flight check is defense-in-depth only, not the primary SSRF control.
 */
function validateSsrf(url: URL): void {
  const scheme = url.protocol; // e.g. "http:", "file:"

  if (scheme !== "http:" && scheme !== "https:") {
    throw new SsrfBlockedError(
      `Blocked scheme: ${scheme.replace(":", "://")} — only http:// and https:// are allowed`
    );
  }

  const hostname = url.hostname.toLowerCase();

  // IPv6 addresses (including those with brackets stripped by URL parser)
  const isIpv6 = hostname.includes(":");
  if (isIpv6) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    // ::1 — IPv6 loopback
    if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") {
      throw new SsrfBlockedError(`Blocked IPv6 loopback: ${hostname}`);
    }
    // fc00::/7 — Unique Local Addresses (ULA, private equiv of RFC1918)
    // fc00:: and fd00:: both fall in fc00::/7
    if (ipv6HasPrefix(hostname, "fc", 7) || bare.startsWith("fc") || bare.startsWith("fd")) {
      throw new SsrfBlockedError(`Blocked private IPv6 (ULA fc00::/7): ${hostname}`);
    }
    // fe80::/10 — link-local
    if (bare.startsWith("fe8") || bare.startsWith("fe9") || bare.startsWith("fea") || bare.startsWith("feb")) {
      throw new SsrfBlockedError(`Blocked IPv6 link-local (fe80::/10): ${hostname}`);
    }
    // Block all remaining IPv6 that aren't public — safest posture
    // (public unicast is 2000::/3, which starts with 2 or 3)
    if (!bare.startsWith("2") && !bare.startsWith("3")) {
      throw new SsrfBlockedError(`Blocked non-public IPv6 address: ${hostname}`);
    }
    return; // Passed all IPv6 checks
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
 * Strip all HTML tags from a string, returning only text content.
 * Used as the final fallback when both Readability and JSDOM body extraction fail.
 * Avoids returning raw HTML (which may contain <script> tags) into stored content.
 */
function stripHtmlTags(html: string): string {
  // Remove script/style blocks entirely (content is not useful text)
  let stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ");
  // Replace remaining tags with spaces, then normalize whitespace
  stripped = stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped;
}

/**
 * Convert HTML content to readable markdown-ish text using @mozilla/readability.
 * Falls back to JSDOM text extraction, then tag-stripping if all else fails.
 * Never returns raw HTML — always returns sanitized text.
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
    // Readability parse failed — fall through to JSDOM text extraction
  }

  // Fallback 1: JSDOM body text extraction
  try {
    const dom = new JSDOM(html);
    const text = dom.window.document.body?.textContent?.trim();
    if (text) return text;
  } catch {
    // JSDOM failed — fall through to tag-stripping
  }

  // Fallback 2: regex tag stripping — always returns text, never raw HTML.
  // This prevents <script> / <style> content from landing in stored memories.
  return stripHtmlTags(html);
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
      throw new Error(`Empty response body (no readable stream) from ${rawUrl}`);
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
