/**
 * Offline client demo: same queries as client-remote, answered from a local
 * SQLite snapshot with no server involved.
 *
 *   bun examples/client-local.ts [--db=./data/demo.sqlite]
 */

import { ArtistSignatures } from "@artist-signatures/client";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const api = await ArtistSignatures.fromDataset(arg("db", "./data/demo.sqlite"));
const show = (label: string, value: unknown) => console.log(`\n### ${label}\n` + JSON.stringify(value, null, 2));

show("search('test')", await api.search("test"));
show("signatures('The Test Tones')", await api.signatures("The Test Tones"));
show("getSignature('Ada Melody')", await api.getSignature("Ada Melody"));
