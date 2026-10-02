import { describe, expect, test } from "bun:test";
import { bestSignature, rankSignatures, scoreArtistMatch, scoreSignature, type RankableSignature } from "./rank";

describe("scoreArtistMatch", () => {
  test("exact name beats exact alias beats prefix", () => {
    expect(scoreArtistMatch("dua lipa", "dua lipa", [])).toEqual({ score: 100, via: "exact_name" });
    expect(scoreArtistMatch("dua lipa singer", "dua lipa", ["dua lipa singer"])).toEqual({ score: 90, via: "exact_alias" });
    expect(scoreArtistMatch("dua", "dua lipa", []).via).toBe("prefix");
  });

  test("token order does not matter; token prefixes match", () => {
    expect(scoreArtistMatch("lipa dua", "dua lipa", []).via).toBe("tokens");
    expect(scoreArtistMatch("du lip", "dua lipa", []).via).toBe("token_prefix");
  });

  test("typos still match, unrelated names do not", () => {
    const typo = scoreArtistMatch("dua lpia", "dua lipa", []);
    expect(typo.via).toBe("fuzzy");
    expect(typo.score).toBeGreaterThan(0);
    expect(scoreArtistMatch("madonna", "dua lipa", ["duet"])).toEqual({ score: 0, via: "none" });
    expect(scoreArtistMatch("  ", "dua lipa", [])).toEqual({ score: 0, via: "none" });
  });

  test("alias can rescue an otherwise fuzzy match to exact", () => {
    expect(scoreArtistMatch("the beatles", "beatles", ["the beatles"])).toEqual({ score: 90, via: "exact_alias" });
  });
});

const sig = (over: Partial<RankableSignature["signature"]> = {}, extra: Partial<RankableSignature> = {}): RankableSignature => ({
  signature: { id: "sig_x", type: "handwritten", format: "svg", status: "available", verification: "unverified", ...over },
  licenses: [{ status: "known" }],
  sources: [{ originalUrl: "https://upload.wikimedia.org/x" }],
  resolutions: [{ confidence: 1 }],
  ...extra,
});

describe("scoreSignature / rankSignatures", () => {
  test("known license dominates; svg beats png; verified beats not", () => {
    const pngVerified = sig({ id: "sig_a", format: "png", verification: "verified" }, { resolutions: [{ confidence: 0.9 }] });
    const svgPlain = sig({ id: "sig_b", format: "svg" }, { resolutions: [{ confidence: 1 }] });
    // png+verified (20+20+18=158+base) vs svg+plain (30+0+20=150+base): verification wins.
    expect(rankSignatures([svgPlain, pngVerified]).map((s) => s.signature.id)).toEqual(["sig_a", "sig_b"]);
    const unknownLic = sig({ id: "sig_c", format: "svg" }, { licenses: [{ status: "unknown" }] });
    expect(rankSignatures([unknownLic, svgPlain])[0].signature.id).toBe("sig_b");
  });

  test("unavailable records are filtered; restricted sorts last", () => {
    const gone = sig({ id: "sig_gone", status: "unavailable" });
    const ok = sig({ id: "sig_ok" });
    expect(bestSignature([gone, ok])?.signature.id).toBe("sig_ok");
    // Unavailable is a hard filter even when alone: callers 404 instead.
    expect(bestSignature([gone])).toBeUndefined();
    expect(bestSignature([])).toBeUndefined();
    const restricted = sig({ id: "sig_r" }, { licenses: [{ status: "restricted" }] });
    expect(rankSignatures([restricted, ok])[0].signature.id).toBe("sig_ok");
    expect(rankSignatures([restricted])[0].signature.id).toBe("sig_r");
  });

  test("ties break deterministically on id; missing data scores zero-ish, never throws", () => {
    const a = sig({ id: "sig_b" });
    const b = sig({ id: "sig_a" });
    expect(rankSignatures([a, b]).map((s) => s.signature.id)).toEqual(["sig_a", "sig_b"]);
    expect(() => scoreSignature({ signature: { id: "x" } })).not.toThrow();
  });
});
