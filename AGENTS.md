# AGENTS.md

Working rules for this repository. Detailed reference lives in the linked
documents — read the one your task needs rather than carrying all of it here.

## Read as needed

- [Architecture](docs/architecture.md) — layers, source layout, the page adapter,
  the memory model, testing layers, glossary of domain terms. Read when changing
  module boundaries or when a term is unclear.
- [TypeScript conventions](docs/typescript.md) — types, lint rules, naming,
  comments and the anti-patterns drawn from what has gone wrong here. Read before
  writing code in an area you have not touched.
- `skills/dy/` — the agent-facing skill. Separate audience: it teaches an agent
  to use `dy`, not to change it.

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

Two commitments shape most of the code:

- **The tool never decides for the account.** Every write leaves a receipt
  before it can dispatch, a `delivery_uncertain` write is never retried
  automatically, and identity is always a stable id rather than a display name.
- **The page is the source of truth, not the fixture.** A test that passes while
  the live page fails is the expected state. Real-page evidence is what turns a
  claim into a fix.

## Code and behavior

- Read affected files before changing them. Trace the operation owner before
  choosing a fix. Keep argument handlers thin.
- Metadata owns WHAT; help guidance owns command prerequisites and recovery;
  `skills/dy/references/` owns cross-command workflows that an agent reads.
  Keep help/schema descriptions in the catalog.
- Success goes to stdout as one `{ok:true,data}` envelope. Failures go to stderr
  as one `{ok:false,error}` envelope and a nonzero exit. Explicit help/version
  and TUI are documented presentation exceptions.
- Error `type`, `code`, exit values, flags and response fields are public
  contracts. Preserve exact accepted message text. Never replace a requested
  action silently.
- Dry-run validates and resolves supplied text without starting Chrome, creating
  state, filling inputs or sending content.
- Save a receipt before a write can dispatch. Reusing a confirmed request ID
  returns the receipt. A pending/uncertain dispatch must never be automatically
  resent.
- Serialize operations per account profile. If ownership is lost, cancel the
  operation. Preserve corrupt state for diagnosis.
- Direct external dependencies use exact versions. Update the lockfile with
  `pnpm install --ignore-scripts`; use `pnpm install --frozen-lockfile
  --ignore-scripts` for clean installs. No implicit package lifecycle scripts.
- Edit TypeScript sources, then regenerate `dist/`. Do not hand-edit build output.

The type, lint and naming rules are in [docs/typescript.md](docs/typescript.md).
They are short and they are enforced — read them before a first change.

## Checks

After code changes run `pnpm check` and the relevant `node --test
test/<file>.test.ts`. Before delivery run `pnpm test` and `pnpm build`.

Browser changes also require `pnpm test:browser` after building. These tests use
a temporary Chrome profile, intercepted fixture pages and no account
credentials. Test success is not proof of logged-in Douyin behavior. Report
real-platform validation separately.

`pnpm crap` ranks functions by complexity weighted by real coverage. Use it
before deciding what to refactor; complexity alone ranks a long dispatcher above
a small untested function, which is backwards.

Stage explicit paths and inspect the resulting diff before committing. Do not
commit credentials, cookies, Chrome profiles, private messages or local state.

## Verification and knowledge ownership

- A verifier must run, observe the property it claims to test, and reach the
  intended condition. Read resulting files after generated or bulk edits.
- Keep the account Chrome session and its lock separate from bot identity and
  memory. A browser operation must resolve its workspace before it connects.
- Markdown is the memory body source of truth. Parse all files before replacing
  an index; malformed data must not clear valid data. Corrections retain IDs and
  require the current revision.
- Preserve original error causes and expose failures through typed errors. Do not
  weaken gates to hide a failure.
- Keep tracked source in current architecture terms. Use ShuaDouyin as the
  display name and dy as the executable.
- Bot AGENTS.md and PROFILES.md are user-owned create-only templates. The
  repository AGENTS.md is a developer guide. They have different owners.

## Keeping secrets out

- Keep credentials, cookies, Chrome profiles, private messages, local state and
  captures out of the repository. Never log cookie values or browser storage
  contents.
- A token pasted into a conversation is not a file to write. Never commit one,
  and never put one in a test fixture.

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
