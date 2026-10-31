# Architecture

Detailed layout, module ownership and the reasoning behind them. Read the
section you need; repository-wide working rules stay in [AGENTS.md](../AGENTS.md).

## What this project is

`dy` is a local CLI that lets an agent browse Douyin with a persona and a memory
of its own. It provides operations, visible evidence, account receipts and a bot
workspace. It does not bundle a model, schedule anything, or decide content —
the calling agent does that.

Two design commitments shape most of the code:

- **The tool never decides for the account.** Every write leaves a receipt
  before it can dispatch, a `delivery_uncertain` write is never retried
  automatically, and identity is always a stable id rather than a display name.
- **The page is the source of truth, not the fixture.** A test that passes while
  the live page fails is the expected state. Real-page evidence is what turns a
  claim into a fix.

## Glossary

The words below mean one thing in this repository. Using them loosely is how a
comment ends up describing a behaviour that does not exist.

| Term | Means |
| --- | --- |
| **Work** | One video or one image post. Addressed by a numeric id. |
| **Note** | An image post. Same id space as a video; Douyin redirects `/video/<id>` to `/note/<id>`. |
| **Receipt** | A record written before a write can dispatch, keyed by `request_id`. It is the only evidence that a write was attempted. |
| **`delivery_uncertain`** | The write may have gone out. Never retried automatically; a retry makes two. |
| **Stable id** | The platform's own id: a work id, a `sec_uid`, a comment id, a conversation id. Never a display name. |
| **Self** | The platform's literal alias for the signed-in account on its own pages. Not an id. |
| **Snapshot** | What one page read saw at one moment: url, page kind, work, note, login and verification gates. |
| **Observation** | A persisted snapshot tied to a command run. `chat.changes` compares two of them. |
| **Concept file** | One memory as a markdown file with YAML frontmatter. The source of truth; SQLite is a projection. |
| **Persona** | `AGENTS.md` in the bot workspace. User-owned; `dy` reads it and never rewrites it except through `persona evolve`, which only touches its own section. |
| **Adapter** | The bundle built from `src/page/` and injected into the real page. It is the only code that knows the DOM. |
| **Marker** | A `data-e2e` attribute. The stable surface across page builds; per-build CSS class hashes are not. |
| **Round** | One browse session recorded with `browse start` / `browse end`, used by reports and lessons. |

## Layers

| Layer | Where | What it does |
| --- | --- | --- |
| Process and arguments | `src/cli.ts`, `src/main.ts`, `src/catalog.ts` | One entry point; every command's metadata, flags and guidance live in the catalog |
| Dispatch | `src/app.ts` | Workspace resolution, locking, and routing to an operation |
| Operations | `src/operations/` | One module per concern: navigation, comments, chat, writes, browsing, social, live |
| Browser | `src/browser.ts` | Dedicated Chrome lifecycle and the CDP connection |
| Page code | `src/page/` | TypeScript that runs inside the real Douyin page; the only place that knows the DOM |
| Memory | `src/memory/`, `src/memory.ts` | Markdown concept files, an SQLite projection of them, relations and recall |
| Local state | `src/store.ts` | Profile files, locking, atomic writes, event log and receipts |
| Human surface | `src/tui.ts` | A terminal interface over the same operations |

## Source layout

| Path | Owner |
| --- | --- |
| `src/cli.ts` | Process entry and signals |
| `src/main.ts` | Argument wiring and output placement |
| `src/catalog.ts` | Command metadata, flags, guidance and schema |
| `src/app.ts` | Bot/account resolution, locking and command dispatch |
| `src/operations/` | One module per browser concern: validation, navigation, capture, comments, chat, writes |
| `src/memory/` | Concept files, SQLite projection, relations, views and maintenance |
| `src/browser.ts` | Dedicated Chrome lifecycle and CDP connection |
| `src/page/` | TypeScript executed inside the actual Douyin page |
| `src/store.ts` | Local profile files, locking, atomic writes and operation facts |
| `src/errors.ts` | Stable failure categories, codes and exits |
| `src/tui.ts` | Human terminal interactions through the same operations |
| `.github/workflows/ci.yml` | Cross-platform checks and isolated Chrome tests |
| `migrations/` | Versioned SQLite DDL |
| `src/database.ts`, `src/schema.ts` | SQLite connections, migration and typed database model |
| `src/knowledge.ts` | Local knowledge command routing and validation |
| `src/memory.ts` | The single MemoryStore entry point over `src/memory/` |
| `src/workspace.ts` | Bot registry, persona/profile files and daily reports |
| `test/` | Unit tests and the fixture page the browser tests run against |
| `src/operations/diagnostics.ts` | Repeated-failure evidence used to decide what to fix next |

## Memory model

Markdown is the memory body source of truth. The SQLite tables are a projection
that `memory reindex` can rebuild from the files; losing the database loses no
memory. `memory_fts_*` are SQLite's own FTS5 shadow tables — never write them.

`decode()` in `src/memory/concept.ts` is the boundary: a file on disk becomes a
memory there, and everything downstream trusts what it returns. Every malformed
shape is refused with `state_corrupt` rather than filled in with a guess —
`test/concept-decode.test.ts` pins each refusal.

## The page adapter

`src/page/` is bundled by `scripts/build.ts` into `dist/page-adapter.js` (an
IIFE assigned to `DouyinPage`), then injected into the real page as a string by
`Session.call`. `execute()` in `src/page/index.ts` is one switch over operation
names; most arms are one line forwarding to a reader or writer module.

Consequences worth knowing before changing it:

- Node's coverage cannot see this code, so `pnpm crap` reports it at 0%. That is
  a limit of the measurement, not a finding. Use `DY_COVER_PAGE=1 pnpm test:browser`
  to get real coverage for it.
- `src/page/` may use the DOM and nothing else. No filesystem, no network, no
  Node built-ins.
- A change here needs `pnpm build` before the browser tests see it — the CLI
  reads `dist/page-adapter.js`, not the TypeScript.

## Testing layers

| Layer | Runs | Proves |
| --- | --- | --- |
| `test/*.test.ts` | `pnpm test` | Pure functions, store, validation, memory, routing |
| `test/browser.test.ts` | `pnpm test:browser` | The adapter and the write paths against an intercepted fixture page |

Browser tests use a temporary Chrome profile, intercepted fixture pages and no
account credentials. Test success is not proof of logged-in Douyin behavior —
report real-platform validation separately. The fixture is written from the same
understanding that produced the code, so it can only catch a disagreement
between the two; the live page is what settles a claim.

`pnpm crap` ranks functions by complexity weighted by real coverage. It runs the
suite under V8 coverage, so it takes as long as the suite does.

## Diagnostics

Every read, navigation and write lands in the bot's event log, and reached
failures carry their stable error code and elapsed time. `dy diagnostics` groups
those failures by command and code, reports only what repeated, and separately
reports commands whose successful runs got slower — which no error code records.

The data lives in the user's own workspace, not in this repository. A candidate
from it is a lead, never a diagnosis: reproduce it on the real page before
changing code.
