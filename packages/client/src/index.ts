/**
 * Reusable client library (SPEC §35-38).
 *
 * Remote mode talks to the hosted API over HTTP. Dataset mode
 * (`ArtistSignatures.fromDataset`) answers the same queries from a local
 * SQLite snapshot — offline apps, desktop/mobile, self-hosted mirrors.
 *
 * In dataset mode there is no CDN in front: `asset.url` is the upstream
 * original unless `publicBaseUrl` maps the mirrored `asset.path`.
 */

import {
  createDb,
  findArtistByMbid,
  findArtistByNormalized,
  getSignatureFull,
  listSignaturesForArtist,
  searchArtists,
  type ArtistRow,
  type Db,
  type FullSignature,
} from "@artist-signatures/database";
import { normalizeName } from "@artist-signatures/resolver";
import type { FetchFn } from "@artist-signatures/types";
import { findLiveRecords, type DirectDeps } from "@artist-signatures/direct";

export class ArtistSignaturesError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "ArtistSignaturesError";
    this.code = code;
    this.status = status;
  }
}

export interface SignatureFilters {
  format?: string;
  type?: string;
  license?: string;
  source?: string;
  verifiedOnly?: boolean;
  limit?: number;
  cursor?: string;
}

interface Transport {
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

/** `fetch` keeping its receiver: detached `fetch` is an "Illegal invocation" in browsers. */
function boundFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

class HttpTransport implements Transport {
  constructor(
    private baseUrl: string,
    // Bound wrapper, not bare `fetch`: detached `fetch` throws "Illegal
    // invocation" in browsers (see CommonsClient).
    private fetchImpl: FetchFn = boundFetch,
  ) {}
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}?${new URLSearchParams(params)}`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string } } | T;
    if (!res.ok) {
      const err = (body as { error?: { code: string; message: string } }).error;
      throw new ArtistSignaturesError(err?.code ?? "INTERNAL_ERROR", err?.message ?? `HTTP ${res.status}`, res.status);
    }
    return body as T;
  }
}

/** Same JSON shapes as the API, answered from a local snapshot. */
class DatasetTransport implements Transport {
  constructor(
    private db: Db,
    private publicBaseUrl?: string,
  ) {}

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const limit = params.limit !== undefined ? parseInt(params.limit, 10) : 20;
    if (path === "/v1/search") {
      const { results, nextCursor } = searchArtists(this.db, params.q ?? "", normalizeName, limit, params.cursor);
      return {
        results: results.map((r) => ({ type: "artist", id: r.artist.id, name: r.artist.name, musicbrainz_id: r.artist.musicbrainzId, signature_count: r.signatureCount })),
        ...(nextCursor ? { nextCursor } : {}),
      } as T;
    }
    if (path === "/v1/signatures" && params.artist) {
      const artist = findArtistByNormalized(this.db, normalizeName(params.artist));
      if (!artist) throw new ArtistSignaturesError("ARTIST_NOT_FOUND", "No artist was found for the supplied name.", 404);
      return this.artistSignatures(artist, params, limit) as T;
    }
    if (path.startsWith("/v1/name/")) {
      const artist = findArtistByNormalized(this.db, normalizeName(decodeURIComponent(path.slice("/v1/name/".length))));
      if (!artist) throw new ArtistSignaturesError("ARTIST_NOT_FOUND", "No artist was found for the supplied name.", 404);
      return this.artistSignatures(artist, params, limit) as T;
    }
    if (path.startsWith("/v1/artists/")) {
      const artist = findArtistByMbid(this.db, decodeURIComponent(path.slice("/v1/artists/".length)));
      if (!artist) throw new ArtistSignaturesError("ARTIST_NOT_FOUND", "No artist was found for the supplied MusicBrainz ID.", 404);
      const page = listSignaturesForArtist(this.db, artist.id, {}, limit, params.cursor);
      return {
        id: artist.id,
        name: artist.name,
        musicbrainz_id: artist.musicbrainzId,
        wikidata_id: artist.wikidataId,
        signatures: page.items.map((s) => this.shape(s)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      } as T;
    }
    if (path.startsWith("/v1/signatures/")) {
      const full = getSignatureFull(this.db, decodeURIComponent(path.slice("/v1/signatures/".length)));
      if (!full) throw new ArtistSignaturesError("SIGNATURE_NOT_FOUND", "No signature was found for the supplied ID.", 404);
      return this.shape(full) as T;
    }
    throw new ArtistSignaturesError("INVALID_REQUEST", `Unknown path: ${path}`, 400);
  }

  private artistSignatures(artist: ArtistRow, params: Record<string, string>, limit: number): unknown {
    const page = listSignaturesForArtist(
      this.db,
      artist.id,
      {
        ...(params.format ? { format: params.format } : {}),
        ...(params.type ? { type: params.type } : {}),
        ...(params.license ? { license: params.license } : {}),
        ...(params.source ? { source: params.source } : {}),
        ...(params.verified === "true" ? { verifiedOnly: true } : {}),
      },
      limit,
      params.cursor,
    );
    return {
      artist: { id: artist.id, name: artist.name, musicbrainz_id: artist.musicbrainzId, wikidata_id: artist.wikidataId },
      signatures: page.items.map((s) => this.shape(s)),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }

  private shape(full: FullSignature): unknown {
    const s = full.signature;
    const license = full.licenses[0];
    const source = full.sources[0];
    const mirrorUrl = s.assetUrl && this.publicBaseUrl ? `${this.publicBaseUrl.replace(/\/$/, "")}/v1/assets/${s.assetUrl}` : undefined;
    return {
      id: s.id,
      artist: full.artist ? { name: full.artist.name, musicbrainz_id: full.artist.musicbrainzId, wikidata_id: full.artist.wikidataId } : null,
      asset: {
        url: mirrorUrl ?? source?.originalUrl ?? undefined,
        path: s.assetUrl ?? undefined,
        format: s.format,
        type: s.type,
        width: s.width,
        height: s.height,
        sha256: s.sha256,
      },
      source: source ? { provider: source.provider, url: source.sourceUrl, original_url: source.originalUrl } : null,
      license: license ? { name: license.name, url: license.url } : { name: "Unknown", url: undefined },
      verification: s.verification,
    };
  }
}

/**
 * No server, no database: answers name lookups straight from Wikimedia
 * Commons + MusicBrainz over fetch. Works in browsers (both APIs allow
 * cross-origin reads) as well as in Bun/Node. Nothing is persisted and there
 * is no artist index, so only name lookups (`artist`, `signatures`,
 * `getSignature`) are supported — `search` and MBID lookup need a server or
 * a dataset file.
 */
class DirectTransport implements Transport {
  constructor(private deps: DirectDeps = {}) {}

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    if ((path === "/v1/signatures" && params.artist) || path.startsWith("/v1/name/")) {
      const name =
        params.artist ?? decodeURIComponent(path.slice("/v1/name/".length));
      const { artist, items } = await findLiveRecords(name, this.deps);
      if (items.length === 0) {
        throw new ArtistSignaturesError("ARTIST_NOT_FOUND", "No artist was found for the supplied name.", 404);
      }
      let signatures = items.map((i) => i.record);
      if (params.format) signatures = signatures.filter((s) => s.asset.format === params.format);
      if (params.type) signatures = signatures.filter((s) => s.asset.type === params.type);
      if (signatures.length === 0) {
        throw new ArtistSignaturesError("SIGNATURE_NOT_FOUND", "No signature matches the supplied filters.", 404);
      }
      return {
        artist: { name: artist.name, musicbrainz_id: artist.musicbrainzId },
        signatures,
      } as T;
    }
    throw new ArtistSignaturesError(
      "INVALID_REQUEST",
      "Direct mode supports name lookups only; use a server or dataset file for search and MBID lookup.",
      400,
    );
  }
}

export interface ArtistSignaturesOptions {
  baseUrl?: string;
  fetchImpl?: FetchFn;
}

export class ArtistSignatures {
  private transport: Transport;

  constructor(opts: ArtistSignaturesOptions = {}) {
    this.transport = new HttpTransport(opts.baseUrl ?? "http://localhost:3000", opts.fetchImpl);
  }

  private static dataset(db: Db, publicBaseUrl?: string): ArtistSignatures {
    const api = new ArtistSignatures();
    api.transport = new DatasetTransport(db, publicBaseUrl);
    return api;
  }

  /**
   * Offline mode from a SQLite snapshot (SPEC §38).
   * The file must already be migrated (e.g. published dataset or importer output).
   */
  static async fromDataset(path: string, opts: { publicBaseUrl?: string } = {}): Promise<ArtistSignatures> {
    const { db } = createDb(path);
    return ArtistSignatures.dataset(db, opts.publicBaseUrl);
  }

  /**
   * Serverless mode: no API server, no database. Answers name lookups with
   * live upstream requests (`fetch` only — safe in browsers). Nothing is
   * cached or persisted; each call hits Commons/MusicBrainz directly.
   */
  static direct(deps: DirectDeps = {}): ArtistSignatures {
    const api = new ArtistSignatures();
    api.transport = new DirectTransport(deps);
    return api;
  }

  search(query: string, opts: { limit?: number; cursor?: string } = {}) {
    return this.transport.get<{ results: { type: string; id: string; name: string; musicbrainz_id?: string; signature_count: number }[]; nextCursor?: string }>("/v1/search", {
      q: query,
      ...(opts.limit !== undefined ? { limit: String(opts.limit) } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
  }

  artist(name: string, filters: SignatureFilters = {}) {
    return this.transport.get<{ artist: { name: string; musicbrainz_id?: string }; signatures: unknown[]; matches?: unknown[]; nextCursor?: string }>("/v1/signatures", {
      artist: name,
      ...filterParams(filters),
    });
  }

  artistByMusicBrainzId(mbid: string, opts: { limit?: number; cursor?: string } = {}) {
    return this.transport.get(`/v1/artists/${encodeURIComponent(mbid)}`, {
      ...(opts.limit !== undefined ? { limit: String(opts.limit) } : {}),
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });
  }

  signatures(name: string, filters: SignatureFilters = {}) {
    return this.artist(name, filters);
  }

  signature(id: string) {
    return this.transport.get(`/v1/signatures/${encodeURIComponent(id)}`);
  }

  /** SPEC §37: the one call an app needs to render a signature. */
  async getSignature(name: string) {
    const result = (await this.signatures(name)) as { signatures?: { asset: { url?: string } }[] };
    const first = result.signatures?.[0];
    if (!first?.asset?.url) throw new ArtistSignaturesError("SIGNATURE_NOT_FOUND", `No usable signature for '${name}'.`, 404);
    return first;
  }
}

function filterParams(f: SignatureFilters): Record<string, string> {
  return {
    ...(f.format ? { format: f.format } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.license ? { license: f.license } : {}),
    ...(f.source ? { source: f.source } : {}),
    ...(f.verifiedOnly ? { verified: "true" } : {}),
    ...(f.limit !== undefined ? { limit: String(f.limit) } : {}),
    ...(f.cursor ? { cursor: f.cursor } : {}),
  };
}
