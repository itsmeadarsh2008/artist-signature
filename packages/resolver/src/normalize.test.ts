import { describe, expect, test } from "bun:test";
import { normalizeName } from "./normalize";

describe("normalizeName (SPEC §15)", () => {
  test("canonical examples converge", () => {
    for (const variant of ["Dua Lipa", "dua-lipa", "DUA LIPA", "Dua_Lipa", "Dua  Lipa"]) {
      expect(normalizeName(variant)).toBe("dua lipa");
    }
  });
  test("strips accents without destroying the original", () => {
    expect(normalizeName("Beyoncé")).toBe("beyonce");
  });
  test("strips filename boilerplate, extensions, and signature words", () => {
    expect(normalizeName("File:Dua Lipa (nënshkrim).svg")).toBe("dua lipa");
    expect(normalizeName("Signature of Dua Lipa")).toBe("dua lipa");
    expect(normalizeName("Dua Lipa signature.png")).toBe("dua lipa");
  });
  test("punctuation is not identity", () => {
    expect(normalizeName("D'Angelo")).toBe("d angelo");
  });
});
