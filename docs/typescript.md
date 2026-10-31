# TypeScript conventions

How this repository writes TypeScript. The compiler and Biome enforce several of
these already; the list below says which ones are enforced and which are a
choice a reviewer has to hold.

## Enforced by the compiler

`tsconfig.json` turns these on, so a violation fails `pnpm check` rather than
being caught in review:

- `strict` — including `strictNullChecks` and `noImplicitAny`.
- `noUnusedLocals` / `noUnusedParameters`.
- `erasableSyntaxOnly` — this is what bans `enum` and constructor parameter
  properties (`constructor(private readonly store: Store)`). Both are TypeScript
  syntax that emit runtime code, and this project runs its sources directly with
  Node's type stripping in tests.
- `verbatimModuleSyntax` — type-only imports must say `import type`. A
  value import of something used only as a type becomes a runtime import.
- `allowImportingTsExtensions` with `rewriteRelativeImportExtensions` — imports
  carry their `.ts` extension and are rewritten at build time.

## Linting

**Biome does lint and formatting in one binary**, run as `pnpm check`
(`biome check . && tsc --noEmit`). It is not ESLint, deliberately: the whole
repository lints in about 60ms, and there is one config file instead of a plugin
matrix.

`biome.json` on top of `recommended`:

| Rule | Level | Why |
| --- | --- | --- |
| `suspicious/noExplicitAny` | error | `any` turns off the type checker at that point. `unknown` forces the narrowing to be written down. |
| `suspicious/noConfusingVoidType` | error | `void` is a return type, not a generic argument; using it as one hides a discarded value. |
| `suspicious/noDoubleEquals` | error | `==` coerces; this code compares ids and numbers where coercion silently matches the wrong thing. |
| `correctness/useExhaustiveDependencies` | error | A missing dependency in a `useEffect`-shaped hook is a stale value. |
| `nursery/noMisusedPromises` | error | A promise passed where a value is expected is nearly always a missing `await`. |
| `complexity/noExcessiveCognitiveComplexity` | **warn**, max 25 | Reports, does not block. The 52 warnings are all real and all in `src/page/` — see `pnpm crap` for the same functions ranked by coverage. |

**Known gap: there is no `no-floating-promises`.** Biome in this version does not
ship it, and it needs type information. A dropped promise therefore still has to
be caught in review. The convention is to make the discard explicit — `void
promise.catch(...)` for fire-and-forget, `await` otherwise — so a search for
`void ` in a diff is a short review.

Do not introduce ESLint for that one rule. The dependency tree and the second
config would cost more than the rule catches, and the project pins exact
versions.

## The rules that are not enforced, and why they hold anyway

**Use `unknown` at every external boundary, and narrow it immediately.** The
codebase has no `any`. What it has is 208 uses of `unknown`, almost all at a
point where data arrives from somewhere that does not type-check: a page's DOM,
a YAML file, a JSON payload from the site, a SQLite column. `unknown` forces the
narrowing to be written down, and that narrowing is the actual parsing.

**Parse once, where the data enters.** `decode()` in `src/memory/concept.ts` and
`validate()` in `src/operations/validate.ts` are the two boundaries most data
crosses. Everything downstream trusts them. Adding a second check further in is
usually a sign the boundary is not doing its job.

**Assertions (`as`) are for narrowing after a check, not for silencing.** The
72 in this codebase are nearly all `Record<string, unknown>` when reading a
React props object or an event's data, or a DOM element after a selector. If an
assertion is the only thing making a type work, the parse is missing.

## Naming and shape

| Thing | Convention |
| --- | --- |
| Public command ids | `group.action`, lower case, dotted. These are a public contract. |
| Error codes | `snake_case`, from the fixed list in `src/errors.ts`. Also public. |
| Response fields | `snake_case` — the JSON a caller reads. |
| Local variables and functions | `camelCase` |
| Types and interfaces | `PascalCase` |
| Constants that are truly constant | `SCREAMING_SNAKE_CASE` |
| Files | `kebab-case.ts` |
| Test files | `<subject>.test.ts` in `test/` |

Public JSON fields are snake_case because an agent reads them and Douyin's own
payloads are snake_case; local code is camelCase because TypeScript is. Keep the
two apart rather than converting in both directions.

## What a function should look like

- **One decision lives in one place.** The catalog owns command metadata; the
  operation owns behaviour; the adapter owns the DOM. If a rule appears in two
  of those, one of them is wrong.
- **Pure where possible.** The functions with the highest branch counts —
  `validate`, `decode`, `derive`, `responseWindow` — are pure and take their
  inputs as arguments, which is why they can be tested without a browser or a
  store. Keep new logic that way and the test is a function call.
- **Failures are typed.** Throw `CliError` with a code from the fixed list.
  Never throw a bare `Error` for something a caller is expected to handle, and
  never swallow one — `catch {}` is for cleanup only.
- **No new dependency without a reason.** Direct dependencies are exact
  versions. A package that saves twenty lines usually costs more than twenty
  lines of review surface.

## Comments

Comments explain **why**. The code says what.

- Every non-obvious constant gets the observation behind it, not its value
  restated. The good comments in this repo name the bug: "the wrapper and the
  inner element carry the same line, and reading the wrapper joined twenty
  people's messages into one".
- No JSDoc `@param` / `@returns` tags. They restate the signature.
- A comment that says what the next line plainly does is deleted.
- When a decision is deliberately odd, say what went wrong the other way. That
  is the only thing that stops the next person from "fixing" it.

## Anti-patterns

Drawn from what has actually gone wrong here, not from a generic list.

- **Do not put DOM knowledge outside `src/page/`.** If `src/operations/` knows a
  selector, the adapter is missing an operation.
- **Do not read a React record by own properties alone.** Conversation fields
  live on the prototype and get renamed between builds. `own()`, `inherited()`
  and `getterValue()` exist for this.
- **Do not match a CSS class.** Per-build hashes like `s7K4YLGp` change; class
  *substrings* like `webcast-chatroom___item` also match the container. Prefer
  `data-e2e` markers, then structure, then size — never a hash.
- **Do not compare against the whole loaded window when asking "did this
  change".** History loading and a new message look identical that way. Compare
  the newest item.
- **Do not widen a check to make a command succeed.** If an id is ambiguous,
  fail with `identity_mismatch`; do not pick the likely one.
- **Do not add a `--dry-run` or other global flag to a command spec.**
  Commander applies the per-command default after the global value, silently
  overriding it. `test/flags.test.ts` guards this.
- **Do not hand-edit `dist/`.** Edit `src/` and run `pnpm build`.
