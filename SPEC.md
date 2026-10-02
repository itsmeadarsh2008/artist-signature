# Artist Signatures API — SPEC.md

## 1. Goal

Build an open API and dataset containing musician/artist signatures extracted primarily from Wikimedia Commons.

The system must:

- Discover as many relevant Wikimedia signature files as possible.
- Recursively traverse Wikimedia categories.
- Parse Wikimedia file metadata and licensing information.
- Identify the person represented by each signature.
- Resolve artists to stable MusicBrainz IDs.
- Deduplicate signatures.
- Preserve complete source/provenance information.
- Expose signatures through a simple name-based API.
- Provide a reusable client library.
- Support additional sources and community submissions later.

---

# 2. Architecture

```text
                         ┌────────────────────┐
                         │ Wikimedia Commons  │
                         │ MediaWiki API      │
                         └─────────┬──────────┘
                                   │
                                   ▼
                       ┌───────────────────────┐
                       │ Category Discovery    │
                       │ + Recursive Crawler   │
                       └──────────┬────────────┘
                                  │
                                  ▼
                       ┌───────────────────────┐
                       │ File Metadata Parser  │
                       │ wikitext / extmetadata│
                       └──────────┬────────────┘
                                  │
                                  ▼
                       ┌───────────────────────┐
                       │ Artist Resolver       │
                       │ Wikidata              │
                       │ MusicBrainz           │
                       │ Filename/categories   │
                       └──────────┬────────────┘
                                  │
                                  ▼
                       ┌───────────────────────┐
                       │ Normalizer            │
                       │ Names / IDs / URLs    │
                       └──────────┬────────────┘
                                  │
                                  ▼
                       ┌───────────────────────┐
                       │ Deduplication         │
                       │ SHA-256 / source ID   │
                       └──────────┬────────────┘
                                  │
                                  ▼
                 ┌──────────────────────────────────┐
                 │ Database                          │
                 │ Artists / Signatures / Sources   │
                 └────────────────┬─────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             ┌──────────────┐           ┌──────────────┐
             │ REST API     │           │ Dataset      │
             └──────┬───────┘           └──────────────┘
                    │
                    ▼
             ┌──────────────┐
             │ Client SDK   │
             └──────────────┘
```

---

# 3. Components

## 3.1 Importer

Responsible for discovering and importing Wikimedia Commons files.

Responsibilities:

- category traversal
- file discovery
- pagination
- metadata retrieval
- license extraction
- source URL extraction
- original asset URL extraction
- artist/entity extraction
- queue management
- retry handling

The importer must be resumable.

A crash or interruption must not require starting the entire crawl again.

---

## 3.2 Artist Resolver

Converts an unstructured Wikimedia file into a canonical artist.

Resolution order:

```text
Wikidata entity
       ↓
MusicBrainz ID
       ↓
Commons categories
       ↓
File title
       ↓
File description
       ↓
Structured metadata
       ↓
Manual/community verification
```

The resolver should never assume that a filename is the canonical artist name.

Every match receives a confidence score.

Example:

```json
{
  "method": "wikidata",
  "confidence": 1.0
}
```

```json
{
  "method": "musicbrainz_name_match",
  "confidence": 0.82
}
```

---

# 4. Wikimedia Discovery

## 4.1 API

Use the Wikimedia Commons MediaWiki API.

Base endpoint:

```text
https://commons.wikimedia.org/w/api.php
```

Do not scrape HTML pages unless the API does not expose required information.

---

# 5. Category Discovery

The crawler starts from configurable root categories.

Example roots:

```text
Category:Signatures
Category:Autographs
Category:Signatures of people
Category:Autographs of people
```

The exact seed list must remain configurable because Wikimedia categories change over time.

---

## 5.1 Recursive traversal

For every category:

```text
category
 ├── subcategory
 │    ├── subcategory
 │    └── file
 ├── file
 └── file
```

Use the MediaWiki category-members API.

Conceptually:

```text
action=query
list=categorymembers
cmtitle=Category:...
cmtype=subcat|file
cmlimit=max
```

Pagination must use MediaWiki continuation tokens.

Never assume one API response contains the complete category.

---

## 5.2 Category queue

Maintain a persistent queue.

```text
category_queue
----------------
category_title
depth
status
discovered_at
processed_at
```

Statuses:

```text
pending
processing
completed
failed
```

A category is processed only once unless explicitly re-crawled.

---

# 6. File Discovery

For every discovered Wikimedia file:

```text
File:Example Signature.svg
```

store the Commons title immediately.

Example:

```json
{
  "commons_title": "File:Dua Lipa (nënshkrim).svg"
}
```

The file title itself must not be treated as the artist identity.

---

# 7. File Metadata Extraction

Retrieve metadata using the MediaWiki API.

Request:

```text
prop=imageinfo
iiprop=url|size|mime|sha1|timestamp|extmetadata
iiurlwidth=...
```

Important fields:

```text
url
descriptionurl
mime
size
width
height
sha1
timestamp
extmetadata
```

---

# 8. Wikimedia extmetadata

Parse `extmetadata` when available.

Relevant fields include:

```text
Artist
Author
Credit
DateTimeOriginal
ImageDescription
ObjectName
Categories
License
LicenseShortName
UsageTerms
Attribution
Credit
Source
Permission
```

The parser must tolerate:

- missing fields
- HTML in values
- localized values
- arrays
- nested values
- empty strings
- malformed wikitext

Do not rely on one metadata field.

---

# 9. Wikitext Parsing

The complete Commons file description should also be retained.

Example:

```text
== {{int:filedesc}} ==

{{Information
|description = Signature of Example Artist
|date = ...
|source = ...
|author = ...
}}

== {{int:license-header}} ==

{{PD-signature}}
```

The importer should parse common templates.

Priority templates:

```text
Information
Artwork
Photograph
PD-signature
PD-old
CC-BY
CC-BY-SA
CC0
Self
Personality rights
Permission
```

The parser must be extensible rather than hard-coded around one template.

---

# 10. License Extraction

Every imported signature must have license information.

Store:

```json
{
  "license": {
    "name": "CC0",
    "url": "...",
    "source": "wikimedia"
  }
}
```

Possible states:

```text
known
unknown
restricted
requires_review
```

Never assume that a Wikimedia file is automatically free to redistribute.

The API should expose the original license and source.

---

# 11. Source Provenance

Every signature must retain its original source.

Example:

```json
{
  "source": {
    "provider": "wikimedia_commons",
    "file_title": "File:Example.svg",
    "page_url": "...",
    "original_url": "...",
    "revision_id": "...",
    "imported_at": "..."
  }
}
```

The original Commons page must remain available even if the asset is mirrored.

---

# 12. Artist Identification

Artist identification is the most important parsing stage.

Use multiple signals.

## 12.1 Signal sources

```text
1. Wikidata entity
2. MusicBrainz ID
3. Commons categories
4. File title
5. File description
6. Author field
7. ObjectName
8. Source metadata
```

---

# 13. Wikidata Resolution

If the Commons page contains a Wikidata entity:

```text
Qxxxx
```

retrieve the corresponding Wikidata entity.

Extract:

```text
Q-ID
labels
aliases
Wikipedia sitelinks
occupation
instance-of
MusicBrainz artist ID
```

The MusicBrainz artist ID should be preferred whenever available.

---

# 14. MusicBrainz Resolution

MusicBrainz is the canonical artist identity layer.

Store:

```text
musicbrainz_id
name
sort_name
aliases
```

Example:

```json
{
  "musicbrainz_id": "xxx",
  "name": "Dua Lipa"
}
```

MusicBrainz matching must use normalized names and aliases.

Do not automatically accept ambiguous matches.

---

# 15. Name Normalization

Create one normalization function shared by the importer and API.

Example:

```text
"Dua Lipa"
"dua-lipa"
"DUA LIPA"
"Dua_Lipa"
"Dua  Lipa"
```

should normalize to approximately:

```text
dua lipa
```

Normalization should include:

- lowercase
- Unicode normalization
- whitespace normalization
- punctuation normalization
- underscore → space
- hyphen normalization
- removal of harmless filename prefixes
- accent-aware matching

Do not permanently destroy the original name.

Store both:

```text
original_name
normalized_name
```

---

# 16. Matching Algorithm

Candidate generation:

```text
filename
description
categories
Wikidata
aliases
```

Generate candidate artists.

Score candidates.

Example scoring:

```text
Wikidata + MusicBrainz ID       1.00
Exact MusicBrainz-linked name   0.95
Exact Wikidata label            0.90
Exact known alias               0.85
Category exact match            0.80
Normalized filename match       0.70
Fuzzy filename match            0.50
```

These values are implementation defaults, not guarantees.

Automatic import should require a configurable threshold.

Example:

```text
>= 0.90 → automatically accept
0.70–0.89 → review queue
< 0.70 → unresolved
```

---

# 17. Multiple Signatures

An artist may have multiple signatures.

Never overwrite an existing signature.

Example:

```text
Dua Lipa
 ├── signature 1
 ├── signature 2
 └── signature 3
```

Each signature remains an independent record.

---

# 18. Signature Types

Supported values:

```text
handwritten
autograph
digital
monogram
initials
unknown
```

Classification should initially be metadata-based.

Do not attempt computer-vision classification in the MVP.

---

# 19. Asset Formats

Preferred format:

```text
SVG
```

Then:

```text
PNG
JPEG
WebP
other
```

Preserve the original format.

Do not convert the original asset during ingestion.

Optional derived formats may be generated later.

---

# 20. Asset Storage

Store:

```text
original Wikimedia URL
```

and optionally mirror the file.

Recommended structure:

```text
assets/
  signatures/
    <sha256>.<extension>
```

SHA-256 is the canonical content identifier.

Example:

```text
assets/signatures/
a4/2f/a42f...svg
```

Use content-addressable storage.

---

# 21. Deduplication

Deduplicate using:

### Primary

```text
SHA-256(asset bytes)
```

### Secondary

```text
Wikimedia file SHA1
```

### Metadata-level

```text
Commons page ID
```

Two files with different filenames but identical bytes should resolve to one asset.

Multiple sources may still reference the same asset.

---

# 22. Database

PostgreSQL is recommended for production.

SQLite is acceptable for local/single-user deployments.

---

## 22.1 artists

```sql
artists (
    id,
    musicbrainz_id,
    wikidata_id,
    name,
    sort_name,
    normalized_name,
    created_at,
    updated_at
)
```

---

## 22.2 artist_aliases

```sql
artist_aliases (
    id,
    artist_id,
    alias,
    normalized_alias
)
```

---

## 22.3 signatures

```sql
signatures (
    id,
    artist_id,
    type,
    format,
    sha256,
    width,
    height,
    file_size,
    asset_url,
    created_at,
    updated_at
)
```

---

## 22.4 sources

```sql
sources (
    id,
    signature_id,
    provider,
    source_url,
    original_url,
    source_title,
    source_id,
    revision_id,
    imported_at
)
```

---

## 22.5 licenses

```sql
licenses (
    id,
    signature_id,
    name,
    url,
    usage_terms,
    attribution_required,
    status
)
```

---

## 22.6 resolutions

```sql
resolutions (
    id,
    signature_id,
    method,
    confidence,
    raw_name,
    matched_artist_id,
    reviewed,
    created_at
)
```

This preserves why an artist was matched.

---

# 23. Import Pipeline

The complete pipeline:

```text
DISCOVER
   ↓
CATEGORY
   ↓
FILES
   ↓
METADATA
   ↓
PARSE
   ↓
ENTITY EXTRACTION
   ↓
WIKIDATA
   ↓
MUSICBRAINZ
   ↓
NORMALIZE
   ↓
MATCH
   ↓
LICENSE
   ↓
DOWNLOAD
   ↓
HASH
   ↓
DEDUP
   ↓
DATABASE
   ↓
INDEX
```

Each stage should be independently retryable.

---

# 24. Import Jobs

Use jobs rather than one giant script.

```text
crawl-category
fetch-file
parse-file
resolve-artist
download-asset
deduplicate
index-artist
```

Jobs should be idempotent.

Running the same job twice must not create duplicate records.

---

# 25. Incremental Updates

The importer should remember:

```text
last processed timestamp
revision ID
source hash
```

On subsequent crawls:

```text
new file → import
changed file → reprocess
unchanged file → skip
deleted file → mark unavailable
```

Do not immediately delete historical records when a Wikimedia file disappears.

Use:

```text
status = unavailable
```

and preserve provenance.

---

# 26. Rate Limiting

Respect Wikimedia API limits.

Implement:

```text
request queue
concurrency limit
retry with exponential backoff
429 handling
5xx retry
```

User-Agent must identify the application.

Example:

```text
ArtistSignatures/1.0
https://github.com/example/artist-signatures
```

---

# 27. API

The public API should make the common case extremely simple.

## Search by name

```http
GET /v1/signatures?artist=Dua%20Lipa
```

Response:

```json
{
  "artist": {
    "name": "Dua Lipa",
    "musicbrainz_id": "..."
  },
  "signatures": [
    {
      "id": "sig_xxx",
      "type": "handwritten",
      "format": "svg",
      "url": "https://cdn.example.com/...",
      "license": {
        "name": "CC0",
        "url": "..."
      }
    }
  ]
}
```

---

# 28. Artist Endpoint

```http
GET /v1/artists/{musicbrainz_id}
```

Returns:

```json
{
  "id": "...",
  "name": "Dua Lipa",
  "aliases": [],
  "signatures": []
}
```

---

# 29. Simple Name Endpoint

For applications that do not use MusicBrainz:

```http
GET /v1/name/Dua%20Lipa
```

The server performs:

```text
name
 ↓
normalization
 ↓
alias search
 ↓
artist resolution
 ↓
signatures
```

---

# 30. Single Signature

```http
GET /v1/signatures/{id}
```

Returns complete metadata and provenance.

---

# 31. Search

```http
GET /v1/search?q=dua
```

Response:

```json
{
  "results": [
    {
      "type": "artist",
      "id": "...",
      "name": "Dua Lipa"
    }
  ]
}
```

Search should support:

- exact name
- prefix
- aliases
- normalized names
- fuzzy matching

---

# 32. API Filtering

Support:

```text
?format=svg
?type=handwritten
?license=CC0
?verified=true
?source=wikimedia
```

Example:

```http
GET /v1/signatures?artist=Dua%20Lipa&format=svg
```

---

# 33. API Pagination

All collection endpoints should support:

```text
limit
cursor
```

Example:

```http
GET /v1/search?q=smith&limit=20
```

Use cursor pagination instead of offset pagination for large datasets.

---

# 34. API Versioning

Use:

```text
/v1/
```

Breaking changes require:

```text
/v2/
```

Do not silently change response schemas.

---

# 35. Client Library

Provide a small client library.

Example JavaScript:

```ts
import { ArtistSignatures } from "@artist-signatures/client";

const api = new ArtistSignatures();

const result = await api.signatures("Dua Lipa");

console.log(result.signatures);
```

---

# 36. Client API

Minimum interface:

```ts
class ArtistSignatures {
    search(query: string)
    artist(name: string)
    artistByMusicBrainzId(mbid: string)
    signatures(name: string)
    signature(id: string)
}
```

---

# 37. Direct Asset Helper

Provide:

```ts
const signature = await api.getSignature("Dua Lipa");

console.log(signature.url);
```

For applications:

```ts
<img src={signature.url} />
```

---

# 38. Local/Dataset Mode

The client should optionally work without the hosted API.

Example:

```ts
const db = await ArtistSignatures.fromDataset("./signatures.sqlite");

const result = await db.signatures("Dua Lipa");
```

This allows:

- offline apps
- desktop applications
- mobile applications
- self-hosted APIs
- mirrors

---

# 39. Dataset

Publish periodic snapshots.

Formats:

```text
JSON
JSONL
SQLite
Parquet (optional)
```

Recommended:

```text
artists.jsonl
signatures.jsonl
sources.jsonl
licenses.jsonl
```

SQLite should provide the easiest offline experience.

---

# 40. Dataset Record

Example:

```json
{
  "id": "sig_xxx",
  "artist": {
    "name": "Dua Lipa",
    "musicbrainz_id": "..."
  },
  "type": "handwritten",
  "format": "svg",
  "sha256": "...",
  "url": "...",
  "source": {
    "provider": "wikimedia_commons",
    "url": "..."
  },
  "license": {
    "name": "CC0",
    "url": "..."
  }
}
```

---

# 41. Verification

Verification states:

```text
unverified
verified
artist_verified
```

Meaning:

### unverified

Automatically imported and matched.

### verified

Reviewed by project maintainers/community.

### artist_verified

Confirmed by the artist or an authorized representative.

Verification must not be interpreted as proof that an autograph is genuine.

It describes the confidence/provenance of the database record.

---

# 42. Moderation

Provide an administrative interface/API for:

```text
approve
reject
merge
edit
unmatch
remove
restore
```

Every moderation action should create an audit record.

---

# 43. Takedown

Support:

```http
POST /v1/takedowns
```

A takedown request should contain:

```text
signature ID
source
reason
requester
contact
```

The system should be able to disable public serving without destroying historical provenance.

---

# 44. API Response Design

Responses should be predictable.

Never make consumers parse Wikimedia's raw API response.

Bad:

```json
{
  "extmetadata": {
    "...": "..."
  }
}
```

Good:

```json
{
  "id": "...",
  "artist": {...},
  "asset": {...},
  "source": {...},
  "license": {...}
}
```

Raw Wikimedia metadata may optionally be exposed under:

```text
raw_source_metadata
```

for debugging/research.

---

# 45. Caching

Cache:

```text
artist lookup
search results
signature metadata
Wikimedia metadata
```

CDN-cache public signature assets.

Recommended cache keys:

```text
artist:{normalized_name}
artist:{mbid}
signature:{id}
search:{query}
```

---

# 46. Search Index

For a small deployment PostgreSQL is sufficient.

Use:

```text
pg_trgm
```

for fuzzy name matching.

For larger deployments:

```text
PostgreSQL
      +
OpenSearch/Meilisearch/Typesense
```

can be added later.

Do not require a search engine for the MVP.

---

# 47. Error Handling

API errors:

```json
{
  "error": {
    "code": "ARTIST_NOT_FOUND",
    "message": "No artist was found for the supplied name."
  }
}
```

Suggested codes:

```text
ARTIST_NOT_FOUND
SIGNATURE_NOT_FOUND
INVALID_REQUEST
INVALID_FORMAT
RATE_LIMITED
INTERNAL_ERROR
```

---

# 48. Security

The API must:

- validate all input
- limit query sizes
- rate-limit public endpoints
- prevent SSRF in source importers
- sanitize Wikimedia HTML/wikitext
- never execute downloaded files
- validate asset MIME types
- enforce maximum download size
- store downloaded assets outside executable paths

---

# 49. Importer Safety

Downloaded Wikimedia files must be treated as untrusted input.

Validate:

```text
Content-Type
file extension
actual file signature/magic bytes
maximum size
```

SVG requires special care.

Sanitize SVG if it will be served inline.

Prefer:

```html
<img src="...">
```

rather than injecting raw SVG into application HTML.

---

# 50. Observability

Importer metrics:

```text
categories discovered
files discovered
files parsed
files skipped
artists matched
artists unresolved
licenses detected
licenses unknown
assets downloaded
assets deduplicated
API requests
errors
```

Example:

```text
Categories:       18,421
Files discovered: 92,312
Parsed:           91,804
Matched:          76,120
Unresolved:       15,684
Deduplicated:      2,193
```

---

# 51. Import Logs

Every import should have:

```text
job_id
source
started_at
finished_at
status
items_processed
items_failed
error
```

This allows debugging without rerunning the entire dataset.

---

# 52. Recommended Repository

```text
artist-signatures/
├── apps/
│   ├── api/
│   ├── importer/
│   └── admin/
│
├── packages/
│   ├── parser/
│   ├── resolver/
│   ├── database/
│   ├── client/
│   └── types/
│
├── data/
│   └── seeds/
│
├── migrations/
│
├── scripts/
│
├── tests/
│
├── SPEC.md
└── README.md
```

---

# 53. Recommended Stack

Primary implementation:

```text
Runtime:      Bun
API:          Elysia
Database:     PostgreSQL
ORM/query:    Drizzle
Client:       TypeScript
Importer:     Bun/TypeScript
Storage:      S3-compatible object storage
Search:       PostgreSQL pg_trgm
CDN:          Any CDN
```

Local/offline:

```text
SQLite
```

No component should depend on a proprietary cloud provider.

---

# 54. Parser Package

The parser should be independent from the API.

```ts
parseCommonsFile(data): ParsedCommonsFile
```

Output:

```ts
{
  title,
  description,
  categories,
  author,
  artist,
  wikidataId,
  license,
  sourceUrl,
  originalUrl,
  mime,
  width,
  height,
  sha1
}
```

This makes the importer testable without network access.

---

# 55. Resolver Package

```ts
resolveArtist(parsedFile): ArtistResolution
```

Output:

```ts
{
  artist,
  confidence,
  method,
  candidates
}
```

Example:

```json
{
  "artist": {
    "name": "Dua Lipa",
    "musicbrainz_id": "..."
  },
  "confidence": 1,
  "method": "wikidata_musicbrainz"
}
```

---

# 56. Wikimedia Adapter

Keep Wikimedia-specific logic isolated.

```ts
interface SignatureSource {
    discover(): AsyncIterable<SourceItem>;
    fetchMetadata(item): Promise<SourceMetadata>;
    download(item): Promise<Buffer>;
}
```

Then:

```text
WikimediaAdapter
ArtistSubmissionAdapter
CommunitySubmissionAdapter
FutureSourceAdapter
```

can all feed the same pipeline.

---

# 57. Source-Agnostic Data Model

The core database must not assume every signature came from Wikimedia.

```text
signature
    ↓
source
    ↓
provider
```

This allows additional sources later without changing the API.

---

# 58. Import State Machine

Each source item moves through:

```text
DISCOVERED
    ↓
METADATA_FETCHED
    ↓
PARSED
    ↓
RESOLVED
    ↓
LICENSE_CHECKED
    ↓
DOWNLOADED
    ↓
HASHED
    ↓
DEDUPLICATED
    ↓
IMPORTED
```

Possible failure state:

```text
FAILED
```

Retryable failures must return to the previous state.

---

# 59. Unresolved Artists

Do not discard unmatched signatures.

Store them separately:

```text
unresolved_signatures
```

with:

```text
raw title
description
categories
Wikidata ID
candidate artists
confidence
```

These records can later be resolved when MusicBrainz/Wikidata gains better data.

---

# 60. Human Review Queue

Provide:

```http
GET /admin/review/unresolved
```

Reviewer sees:

```text
Wikimedia file
       ↓
Extracted name
       ↓
Candidate artists
       ↓
MusicBrainz information
       ↓
Approve / Reject / Search again
```

Manual resolution becomes part of the dataset rather than being lost.

---

# 61. Artist Search Priority

When `/v1/name/:name` is requested:

```text
exact normalized name
        ↓
alias
        ↓
MusicBrainz name
        ↓
fuzzy match
        ↓
return candidates
```

If multiple artists are plausible, return candidates rather than silently selecting one.

Example:

```json
{
  "matches": [
    {
      "name": "...",
      "musicbrainz_id": "...",
      "signature_count": 2
    }
  ]
}
```

---

# 62. API Simplicity

The primary integration should require only:

```http
GET /v1/name/Dua%20Lipa
```

or:

```ts
api.signatures("Dua Lipa")
```

Everything else exists for advanced consumers.

---

# 63. Public API Example

```text
GET /v1/name/Dua%20Lipa
```

```json
{
  "artist": {
    "name": "Dua Lipa",
    "musicbrainz_id": "..."
  },
  "signatures": [
    {
      "id": "sig_123",
      "type": "handwritten",
      "format": "svg",
      "url": "https://cdn.example.com/sig_123.svg",
      "license": {
        "name": "Public Domain",
        "url": "..."
      },
      "source": {
        "provider": "wikimedia_commons",
        "url": "..."
      }
    }
  ]
}
```

This should be sufficient for a music application to display a signature.

---

# 64. Future Extensions

Possible later features:

```text
AI signature detection
OCR
automatic signature cropping
background removal
SVG tracing
signature similarity
artist profile pages
community corrections
artist verification
GitHub dataset releases
GraphQL API
Rust client
Python client
Swift client
Kotlin client
```

These must not complicate the core importer.

---

# 65. MVP

The first implementation must include:

- Wikimedia category crawler
- recursive category traversal
- pagination
- file metadata extraction
- wikitext parsing
- license extraction
- Wikimedia source preservation
- Wikidata resolution
- MusicBrainz resolution
- artist name normalization
- confidence scoring
- unresolved queue
- SHA-256 deduplication
- PostgreSQL/SQLite storage
- signature API
- name-based lookup
- MusicBrainz-ID lookup
- search
- dataset export
- TypeScript client
- importer resume/retry
- basic moderation

---

# 66. Core Principle

The system is not simply an image scraper.

It is an **artist identity + signature provenance database**.

The canonical relationship is:

```text
Artist
  ↓
MusicBrainz ID
  ↓
Signature
  ↓
Source
  ↓
License
  ↓
Original Wikimedia file
```

The API should make the final lookup extremely simple while keeping the underlying provenance and parsing pipeline comprehensive.

The target developer experience is:

```ts
const result = await signatures.signatures("Dua Lipa");

console.log(result.signatures[0].url);
```

while the backend remains capable of crawling, resolving, validating, deduplicating, updating, and preserving thousands or millions of signature records.
