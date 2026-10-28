# AGENTS.md

## Working language

Repository guidance, issue and PR templates, and commit messages are in English.
Conversation follows the user's language. Keep quoted code, error output and
upstream material in their original language.

Use Conventional Commits for commit messages and PR titles.

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

## Architecture

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

Markdown is the memory body source of truth. The SQLite tables are a projection
that `memory reindex` can rebuild from the files; losing the database loses no
memory. `memory_fts_*` are SQLite's own FTS5 shadow tables — never write them.

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

## Code and behavior

- Read affected files before changing them. Trace the operation owner before choosing a fix. Keep argument handlers thin.
- Use strict types and `unknown` at external boundaries. No `any`, parameter properties, enums, dynamic imports or callback execution from inspected React props.
- Format code with Biome. Favor explicit, readable functions; do not compress multiple statements onto one line.
- Metadata owns WHAT; help guidance owns command prerequisites and recovery; `skills/dy/references/` owns cross-command workflows that an agent reads. Keep help/schema descriptions in the catalog.
- Success goes to stdout as one `{ok:true,data}` envelope. Failures go to stderr as one `{ok:false,error}` envelope and a nonzero exit. Explicit help/version and TUI are documented presentation exceptions.
- Error `type`, `code`, exit values, flags and response fields are public contracts. Preserve exact accepted message text. Never replace a requested action silently.
- Dry-run validates and resolves supplied text without starting Chrome, creating state, filling inputs or sending content.
- Use stable video, comment and conversation IDs. Reject ambiguous controls or identity conflicts. Never substitute display names for stable send targets.
- Save a receipt before a write can dispatch. Reusing a confirmed request ID returns the receipt. A pending/uncertain dispatch must never be automatically resent.
- Keep credentials, cookies, Chrome profiles, private messages, local state and captures out of the repository. Never log cookie values or browser storage contents.
- Serialize operations per account profile. If ownership is lost, cancel the operation. Preserve corrupt state for diagnosis.
- TUI uses the shared operations. Restore terminal modes on exit/cancellation. Sanitize site-provided terminal control sequences and support narrow terminals.
- Direct external dependencies use exact versions. Update the lockfile with `pnpm install --ignore-scripts`; use `pnpm install --frozen-lockfile --ignore-scripts` for clean installs. No implicit package lifecycle scripts.
- Edit TypeScript sources, then regenerate `dist/`. Do not hand-edit build output.

## Checks

After code changes run `pnpm check` and the relevant `node --test test/<file>.test.ts`. Before delivery run `pnpm test` and `pnpm build`.

Browser changes also require `pnpm test:browser` after building. These tests use a temporary Chrome profile, intercepted fixture pages and no account credentials. Test success is not proof of logged-in Douyin behavior. Report real-platform validation separately.

Stage explicit paths and inspect the resulting diff before committing. Do not commit credentials, cookies, Chrome profiles, private messages or local state.

## Verification and knowledge ownership

- A verifier must run, observe the property it claims to test, and reach the intended condition. Read resulting files after generated or bulk edits.
- Keep the account Chrome session and its lock separate from bot identity and memory. A browser operation must resolve its workspace before it connects.
- Markdown is the memory body source of truth. Parse all files before replacing an index; malformed data must not clear valid data. Corrections retain IDs and require the current revision.
- Preserve original error causes and expose failures through typed errors. Do not weaken gates to hide a failure.
- Keep tracked source in current architecture terms. Use ShuaDouyin as the display name and dy as the executable.
- Bot AGENTS.md and PROFILES.md are user-owned create-only templates. The repository AGENTS.md is a developer guide. They have different owners.

## Additional owners

| Path | Responsibility |
| --- | --- |
| `.github/workflows/ci.yml` | Cross-platform checks and isolated Chrome tests |
| `migrations/` | Versioned SQLite DDL |
| `src/database.ts`, `src/schema.ts` | SQLite connections, migration and typed database model |
| `src/knowledge.ts` | Local knowledge command routing and validation |
| `src/memory.ts` | The single MemoryStore entry point over `src/memory/` |
| `src/workspace.ts` | Bot registry, persona/profile files and daily reports |
| `test/` | Unit tests and the fixture page the browser tests run against |
| `src/operations/diagnostics.ts` | Repeated-failure evidence used to decide what to fix next |

## Diagnostics

Every read, navigation and write lands in the bot's event log, and reached
failures carry their stable error code and elapsed time. `dy diagnostics` groups
those failures by command and code, reports only what repeated, and separately
reports commands whose successful runs got slower — which no error code records.

The data lives in the user's own workspace, not in this repository. A candidate
from it is a lead, never a diagnosis: reproduce it on the real page before
changing code.

## What the tool must never decide

`dy` acts on a real account. The code's job is to make every action auditable
and reversible by the person running it — not to decide whether the action is
appropriate. Two rules follow from that:

- A write leaves a receipt before it can dispatch. A `delivery_uncertain` write
  is never retried automatically: it may already be out, and sending again makes
  two.
- Anything irreversible stays behind an explicit request. Never guess an
  identity, never substitute a display name for a stable id, and never widen a
  check to make a command succeed.

What the maintainers will not accept in a contribution: a feature that sends to
accounts the user did not name, a change that hides a failure instead of fixing
it, or a default that acts before it is asked to.

