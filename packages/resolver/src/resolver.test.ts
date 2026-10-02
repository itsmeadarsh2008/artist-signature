import { describe, expect, test } from "bun:test";
import { resolveArtist, type KnownArtist, type ResolvableFile } from "./index";

const DUA: KnownArtist = {
  id: "artist-1",
  name: "Dua Lipa",
  musicbrainzId: "mbid-dua",
  wikidataId: "Q12345",
  aliases: ["Dua Lipa Singer"],
};

describe("resolveArtist (SPEC §16)", () => {
  test("wikidata + musicbrainz resolves at 1.00", () => {
    const file: ResolvableFile = { title: "File:xyz.svg", categories: [], wikidataId: "Q12345" };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("accepted");
    expect(r.confidence).toBe(1);
    expect(r.method).toBe("wikidata_musicbrainz");
    expect(r.artist?.musicbrainzId).toBe("mbid-dua");
  });

  test("exact name on an MB-linked artist resolves at 0.95", () => {
    const file: ResolvableFile = { title: "File:Something Else.svg", artist: "Dua Lipa", categories: [] };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("accepted");
    expect(r.confidence).toBe(0.95);
    expect(r.method).toBe("musicbrainz_name_match");
  });

  test("alias match goes to the review queue", () => {
    const file: ResolvableFile = { title: "File:xyz.svg", artist: "Dua Lipa Singer", categories: [] };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("review");
    expect(r.confidence).toBe(0.85);
    expect(r.method).toBe("alias_match");
  });

  test("category match scores 0.80", () => {
    const file: ResolvableFile = { title: "File:xyz.svg", categories: ["Signature of Dua Lipa"] };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("review");
    expect(r.confidence).toBe(0.8);
    expect(r.method).toBe("category_match");
  });

  test("normalized filename match scores 0.70", () => {
    const file: ResolvableFile = { title: "File:Dua-Lipa signature.png", categories: [] };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("review");
    expect(r.confidence).toBe(0.7);
    expect(r.method).toBe("normalized_filename_match");
  });

  test("near-miss filename stays unresolved but keeps the candidate", () => {
    const file: ResolvableFile = { title: "File:Dua Lipaa signature.svg", categories: [] };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("unresolved");
    expect(r.artist).toBeNull();
    expect(r.candidates[0]).toMatchObject({ method: "fuzzy_filename_match", confidence: 0.5 });
  });

  test("no signal means unresolved with no artist", () => {
    const file: ResolvableFile = { title: "File:Random Doodle.svg", categories: ["Doodles"] };
    const r = resolveArtist(file, [DUA]);
    expect(r.status).toBe("unresolved");
    expect(r.artist).toBeNull();
  });

  test("thresholds are configurable", () => {
    const file: ResolvableFile = { title: "File:Dua Lipaa signature.svg", categories: [] };
    const r = resolveArtist(file, [DUA], { reviewThreshold: 0.4 });
    expect(r.status).toBe("review");
    expect(r.artist?.name).toBe("Dua Lipa");
  });
});
