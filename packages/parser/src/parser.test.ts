import { describe, expect, test } from "bun:test";
import {
  extractCategories,
  extractLicense,
  extractNameFromText,
  extractWikidataId,
  extText,
  parseCommonsFile,
  parseTemplates,
  type CommonsFileInput,
} from "./index";

const DUA_INPUT: CommonsFileInput = {
  title: "File:Dua Lipa (nënshkrim).svg",
  pageid: 12345,
  url: "https://upload.wikimedia.org/wikipedia/commons/1/2/Dua_Lipa.svg",
  descriptionurl: "https://commons.wikimedia.org/wiki/File:Dua_Lipa_(n%C3%ABnshkrim).svg",
  mime: "image/svg+xml",
  size: 1234,
  width: 200,
  height: 100,
  sha1: "abc123",
  timestamp: "2024-01-01T00:00:00Z",
  extmetadata: {
    ImageDescription: { value: 'Signature of <a href="/wiki/Dua_Lipa">Dua Lipa</a>' },
    Artist: { value: "Dua Lipa" },
    Categories: { value: "SVG signatures" },
  },
  wikitext: `== {{int:filedesc}} ==
{{Information
|description = Signature of Dua Lipa
|date = 2024
|source = Own work
|author = Example
}}
== {{int:license-header}} ==
{{PD-signature}}
[[Category:Signatures of Dua Lipa]]
[[Category:Dua Lipa|Signature]]
See https://www.wikidata.org/wiki/Q12345 for the artist.
`,
};

describe("parseCommonsFile", () => {
  test("extracts description, artist hint, categories, wikidata, license", () => {
    const p = parseCommonsFile(DUA_INPUT);
    expect(p.title).toBe("File:Dua Lipa (nënshkrim).svg");
    expect(p.description).toBe("Signature of Dua Lipa");
    expect(p.artist).toBe("Dua Lipa");
    expect(p.author).toBe("Dua Lipa");
    expect(p.categories).toEqual(["Signatures of Dua Lipa", "Dua Lipa", "SVG signatures"]);
    expect(p.wikidataId).toBe("Q12345");
    expect(p.license).toMatchObject({ name: "PD-signature", source: "wikimedia", status: "known" });
    expect(p.sourceUrl).toContain("commons.wikimedia.org");
    expect(p.originalUrl).toContain("upload.wikimedia.org");
    expect(p.mime).toBe("image/svg+xml");
    expect(p.sha1).toBe("abc123");
  });

  test("tolerates missing extmetadata and wikitext", () => {
    const p = parseCommonsFile({ title: "File:Bare.png" });
    expect(p.categories).toEqual([]);
    expect(p.artist).toBeUndefined();
    expect(p.license.status).toBe("unknown");
  });
});

describe("extText", () => {
  test("strips HTML, decodes entities, collapses whitespace", () => {
    expect(extText("a<br/>b")).toBe("a b");
    expect(extText("Fish &amp; Chips &lt;3")).toBe("Fish & Chips <3");
    expect(extText("  a   b\nc ")).toBe("a b c");
  });
  test("non-strings and empties yield undefined", () => {
    expect(extText(42)).toBeUndefined();
    expect(extText("<br/>")).toBeUndefined();
    expect(extText("")).toBeUndefined();
  });
});

describe("parseTemplates", () => {
  test("parses named params and keeps nested templates intact", () => {
    const t = parseTemplates("{{Information|description={{en|Signature of X}}|date=2024}}");
    expect(t).toHaveLength(1);
    expect(t[0].name).toBe("Information");
    expect(t[0].named["description"]).toBe("{{en|Signature of X}}");
    expect(t[0].named["date"]).toBe("2024");
  });
  test("stops on unbalanced braces instead of emitting garbage", () => {
    expect(parseTemplates("text {{unclosed")).toEqual([]);
  });
});

describe("extractCategories", () => {
  test("handles piped sort keys", () => {
    expect(extractCategories("[[Category:Dua Lipa|Signature]]", undefined)).toEqual(["Dua Lipa"]);
  });
});

describe("extractWikidataId", () => {
  test("matches interwiki d: links", () => {
    expect(extractWikidataId("depicts [[d:Q12345|Dua Lipa]]", [])).toBe("Q12345");
  });
  test("ignores bare Q-numbers outside entity contexts", () => {
    expect(extractWikidataId("Q4 2024 report", [])).toBeUndefined();
  });
});

describe("extractLicense", () => {
  test("restricted signals win over free ones", () => {
    const lic = extractLicense([{ name: "Non-free biog-pic", params: [], named: {} }], "PD", undefined);
    expect(lic.status).toBe("restricted");
  });
  test("CC0 short name maps to known license with URL", () => {
    const lic = extractLicense([], "CC0", undefined);
    expect(lic).toMatchObject({ name: "CC0 1.0", status: "known" });
    expect(lic.url).toContain("creativecommons.org");
  });
  test("unrecognized templates go to review, absence stays unknown", () => {
    expect(extractLicense([{ name: "Some unknown license", params: [], named: {} }], undefined, undefined).status).toBe(
      "requires_review",
    );
    expect(extractLicense([], undefined, undefined).status).toBe("unknown");
  });
});

describe("extractNameFromText", () => {
  test("pulls names from signature/autograph phrasing", () => {
    expect(extractNameFromText("Signature of Dua Lipa")).toBe("Dua Lipa");
    expect(extractNameFromText("autograph by Freddie Mercury.")).toBe("Freddie Mercury");
    expect(extractNameFromText("just a photo")).toBeUndefined();
  });
});

describe("extractLicense (real Commons spellings)", () => {
  test("{{self|cc-by-sa-4.0}} resolves through the template params", () => {
    const lic = extractLicense([{ name: "self", params: ["cc-by-sa-4.0"], named: {} }], "CC BY-SA 4.0", undefined);
    expect(lic).toMatchObject({ name: "CC BY-SA", status: "known" });
    expect(lic.url).toContain("creativecommons.org");
  });

  test("space-separated short names match the same grants", () => {
    expect(extractLicense([], "CC BY-SA 4.0", undefined)).toMatchObject({ name: "CC BY-SA", status: "known" });
    expect(extractLicense([], "CC BY 3.0", undefined)).toMatchObject({ name: "CC BY", status: "known" });
    expect(extractLicense([], "CC0", undefined)).toMatchObject({ name: "CC0 1.0", status: "known" });
  });
});
