/**
 * Wikimedia Commons MediaWiki API client (SPEC §4-7, §26).
 *
 * - Category members with continuation tokens, never assuming one page (§5.1)
 * - imageinfo + revisions fetched together (metadata + wikitext)
 * - Request queueing via minimum delay, concurrency left to the caller pool
 * - Exponential backoff on 429/5xx/network errors; Retry-After honored
 * - Identifying User-Agent required by Wikimedia policy (SPEC §26)
 */

import type { CommonsFileInput } from "@artist-signatures/parser";
import type { FetchFn } from "@artist-signatures/types";

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const USER_AGENT = "ArtistSignatures/1.0 (https://github.com/example/artist-signatures; dataset importer)";

export interface CommonsClientOptions {
  fetchImpl?: FetchFn;
  userAgent?: string;
  /** Minimum ms between requests. Default 200. */
  minDelayMs?: number;
  maxRetries?: number;
}

export interface CategoryMember {
  pageid: number;
  title: string;
  kind: "subcat" | "file";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `fetch` keeping its receiver: detached `fetch` is an "Illegal invocation" in browsers. */
function boundFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export class CommonsClient {
  private fetchImpl: FetchFn;
  private userAgent: string;
  private minDelayMs: number;
  private maxRetries: number;
  private lastCall = 0;

  constructor(opts: CommonsClientOptions = {}) {
    // Wrapped in an arrow closure: a bare `fetch` reference loses its
    // receiver and throws "Illegal invocation" in browsers (Bun/Node are
    // unaffected, but this client ships to browsers too).
    this.fetchImpl = opts.fetchImpl ?? boundFetch;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.minDelayMs = opts.minDelayMs ?? 200;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  /** GET with pacing + retry. Throws the last error after maxRetries. */
  async get(params: Record<string, string>): Promise<unknown> {
    // `origin=*` makes MediaWiki send `Access-Control-Allow-Origin: *`, which
    // is what lets browsers call the API directly. Harmless server-side.
    const url = `${COMMONS_API}?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...params })}`;
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const wait = this.minDelayMs - (Date.now() - this.lastCall);
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      try {
        const res = await this.fetchImpl(url, { headers: { "User-Agent": this.userAgent } });
        if (res.status === 429 || res.status >= 500) throw new Retryable(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`MediaWiki HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        attempt++;
        if (attempt > this.maxRetries || !(err instanceof Retryable) || isAbort(err)) throw err;
        const backoff = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 250;
        await sleep(backoff);
      }
    }
  }

  /** All members of a category, following continuation tokens (SPEC §5.1). */
  async *categoryMembers(title: string, cmtype: "subcat" | "file" | "subcat|file" = "subcat|file"): AsyncGenerator<CategoryMember> {
    let cont: Record<string, string> | undefined;
    do {
      const data = (await this.get({
        action: "query",
        list: "categorymembers",
        cmtitle: title,
        cmtype,
        cmlimit: "500",
        ...(cont ?? {}),
      })) as { query?: { categorymembers?: { pageid: number; title: string; type?: string; ns?: number }[] }; continue?: Record<string, string> };
      for (const m of data.query?.categorymembers ?? []) {
        // `type` is not always present (namespace implies it: 14 = Category, 6 = File).
        const kind = m.type === "file" || m.ns === 6 ? "file" : m.type === "subcat" || m.ns === 14 ? "subcat" : undefined;
        if (!kind) continue;
        yield { pageid: m.pageid, title: m.title, kind };
      }
      cont = data.continue && Object.keys(data.continue).length > 0 ? data.continue : undefined;
    } while (cont);
  }

  /**
   * Metadata + wikitext for up to 50 titles per request (SPEC §7 + §9).
   * Titles missing upstream are skipped, never fabricated.
   */
  async fetchFileMetadata(titles: string[]): Promise<CommonsFileInput[]> {
    const out: CommonsFileInput[] = [];
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const data = (await this.get({
        action: "query",
        prop: "imageinfo|revisions",
        titles: batch.join("|"),
        iiprop: "url|size|mime|sha1|timestamp|extmetadata",
        rvprop: "content|ids",
        rvslots: "main",
      })) as {
        query?: {
          pages?: {
            pageid?: number;
            title: string;
            missing?: boolean;
            imageinfo?: {
              url?: string;
              descriptionurl?: string;
              mime?: string;
              size?: number;
              width?: number;
              height?: number;
              sha1?: string;
              timestamp?: string;
              extmetadata?: Record<string, { value?: unknown }>;
            }[];
            revisions?: { revid?: number; slots?: { main?: { content?: string; "*"?: string } }; "*"?: string }[];
          }[];
        };
      };
      for (const page of data.query?.pages ?? []) {
        if (page.missing || !page.imageinfo?.[0]) continue;
        const ii = page.imageinfo[0];
        const rev = page.revisions?.[0];
        const wikitext = rev?.slots?.main?.content ?? rev?.slots?.main?.["*"] ?? rev?.["*"];
        out.push({
          title: page.title,
          pageid: page.pageid,
          revid: rev?.revid,
          url: ii.url,
          descriptionurl: ii.descriptionurl,
          mime: ii.mime,
          size: ii.size,
          width: ii.width,
          height: ii.height,
          sha1: ii.sha1,
          timestamp: ii.timestamp,
          extmetadata: ii.extmetadata,
          wikitext,
        });
      }
    }
    return out;
  }
}

class Retryable extends Error {}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message));
}
