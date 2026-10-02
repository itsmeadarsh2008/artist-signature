/**
 * Remote client demo: talks to a running API over HTTP.
 * Start one first, e.g. `just api` (defaults match this script).
 *
 *   bun examples/client-remote.ts [--base-url=http://localhost:3499]
 */

import { ArtistSignatures } from "@artist-signatures/client";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const api = new ArtistSignatures({ baseUrl: arg("base-url", "http://localhost:3499") });
const show = (label: string, value: unknown) => console.log(`\n### ${label}\n` + JSON.stringify(value, null, 2));

show("search('ada')", await api.search("ada"));
show("signatures('Ada Melody')", await api.signatures("Ada Melody"));
show("signatures('Ada Melody', { format: 'svg' })", await api.signatures("Ada Melody", { format: "svg" }));
show("artistByMusicBrainzId('11111111-…')", await api.artistByMusicBrainzId("11111111-1111-1111-1111-111111111111"));
show("getSignature('Ada Melody')", await api.getSignature("Ada Melody"));
show("signatures('Ad') -> matches envelope", await api.signatures("Ad"));
show("signatures('Nobody Famous') -> 404", await api.signatures("Nobody Famous").catch((e) => ({ error: e.code })));
