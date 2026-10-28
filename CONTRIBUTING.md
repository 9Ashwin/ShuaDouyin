# Contributing

Read [AGENTS.md](AGENTS.md) for ownership and behavior contracts. Keep changes focused on one operation, reliability fix or interaction improvement.

1. Find the operation in `src/catalog.ts`, then trace `main.ts` → `app.ts` → its owner in `src/operations/`, `src/memory/`, `src/page/` or `src/store.ts`.
2. Add or change TypeScript at the owning boundary. TUI and CLI must share the operation implementation.
3. Add a regression test for observable behavior. Use temporary directories and fixture pages; never rely on developer cookies, accounts or private data.
4. Update canonical metadata and relevant guidance when the public contract changes.
5. Run `pnpm check`, relevant tests, `pnpm test`, and `pnpm build`. Browser changes also require `pnpm test:browser`.

Direct dependency versions are exact. Use `pnpm install --ignore-scripts` when changing them and inspect the lockfile diff. CI installs with `pnpm install --frozen-lockfile --ignore-scripts`.

For bugs, include the `dy --version` output, OS/Chrome versions, command with private text redacted, structured error code, and whether reproduction used fixtures or a real logged-in page. Do not attach Chrome profiles, cookies, private messages or raw local state.

For a PR, describe the failing trigger, resulting behavior and validation evidence. Distinguish synthetic/browser-fixture checks from real platform checks. Never imply that a clicked control proves delivery.

Optionally use mise for the pinned Node/pnpm toolchain. Run `pnpm hooks:install` once to enable the pre-commit check. Keep actual checks and unverified platform behavior distinct.
