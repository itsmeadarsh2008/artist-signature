import { describe, expect, test } from "bun:test";
import { CommonsClient } from "./wikimedia";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("CommonsClient", () => {
  test("categoryMembers follows continuation tokens", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      if (String(url).includes("cmcontinue")) {
        return jsonResponse({ query: { categorymembers: [{ pageid: 2, title: "File:B.svg", type: "file" }] } });
      }
      return jsonResponse({
        continue: { cmcontinue: "page|2", continue: "-||" },
        query: { categorymembers: [{ pageid: 1, title: "Category:Sub", type: "subcat" }] },
      });
    }) as unknown as typeof fetch;
    const client = new CommonsClient({ fetchImpl, minDelayMs: 0 });
    const members = [];
    for await (const m of client.categoryMembers("Category:Root")) members.push(m);
    expect(members).toEqual([
      { pageid: 1, title: "Category:Sub", kind: "subcat" },
      { pageid: 2, title: "File:B.svg", kind: "file" },
    ]);
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain("cmtitle=Category%3ARoot");
  });

  test("maps members by namespace when `type` is absent (regression)", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        query: {
          categorymembers: [
            { pageid: 1, ns: 14, title: "Category:Sub" },
            { pageid: 2, ns: 6, title: "File:B.svg" },
            { pageid: 3, ns: 0, title: "Something else" },
          ],
        },
      })) as unknown as typeof fetch;
    const client = new CommonsClient({ fetchImpl, minDelayMs: 0 });
    const members = [];
    for await (const m of client.categoryMembers("Category:Root")) members.push(m);
    expect(members).toEqual([
      { pageid: 1, title: "Category:Sub", kind: "subcat" },
      { pageid: 2, title: "File:B.svg", kind: "file" },
    ]);
  });

  test("retries 500s with backoff, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => (++calls === 1 ? jsonResponse({}, 500) : jsonResponse({ ok: true }))) as unknown as typeof fetch;
    const client = new CommonsClient({ fetchImpl, minDelayMs: 0, maxRetries: 2 });
    expect(await client.get({ action: "query" })).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  test("non-retryable errors throw immediately", async () => {
    const fetchImpl = (async () => jsonResponse({}, 400)) as unknown as typeof fetch;
    const client = new CommonsClient({ fetchImpl, minDelayMs: 0, maxRetries: 3 });
    await expect(client.get({ action: "query" })).rejects.toThrow("HTTP 400");
  });

  test("fetchFileMetadata maps imageinfo + revision wikitext, skips missing", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        query: {
          pages: [
            {
              pageid: 10,
              title: "File:A.svg",
              imageinfo: [{ url: "https://up/a.svg", descriptionurl: "https://commons/wiki/A", mime: "image/svg+xml", size: 5, sha1: "s1", timestamp: "2024-01-01T00:00:00Z", extmetadata: { LicenseShortName: { value: "PD" } } }],
              revisions: [{ revid: 99, slots: { main: { content: "{{PD-signature}}\n[[Category:X]]" } } }],
            },
            { title: "File:Gone.svg", missing: true },
          ],
        },
      })) as unknown as typeof fetch;
    const client = new CommonsClient({ fetchImpl, minDelayMs: 0 });
    const [meta] = await client.fetchFileMetadata(["File:A.svg", "File:Gone.svg"]);
    expect(meta.title).toBe("File:A.svg");
    expect(meta.revid).toBe(99);
    expect(meta.wikitext).toContain("PD-signature");
    expect(meta.descriptionurl).toContain("commons");
  });
});
