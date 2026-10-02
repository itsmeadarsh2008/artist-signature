import { randomBytes } from "node:crypto";

/** `sig_9f3a…`, `artist_…`, etc. — opaque, unguessable, prefix-typed. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}
