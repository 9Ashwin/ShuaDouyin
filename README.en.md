<div align="right">
  <span>[<b>English</b>]</span>
  <span>[<a href="./README.md">简体中文</a>]</span>
</div>

<div align="center">

# ShuaDouyin

**An agent that browses Douyin with a persona and a memory. Open source.**

Browsing, comments, direct messages, live rooms, memory — one local CLI that
leaves the judgement to whatever agent is driving it.

<img src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white" alt="Node" />
<img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
<img src="https://img.shields.io/github/stars/9Ashwin/ShuaDouyin?style=social" alt="Stars" />

</div>

---

## What is this

`dy` is a local command-line tool. It bundles no model, schedules nothing, and
decides nothing about content — it provides the state, context and primitives
one browsing round needs, and leaves the judgement to the agent calling it.

What it remembers for you: what this account likes, who it has talked to, which
lines got an answer. What it will not decide for you: whether to send, what to
say, or whether a person is worth knowing.

## Install

```bash
npm install -g shuadouyin
```

`dy` is then on your PATH. The package is `shuadouyin` and the command is `dy`;
the published tarball ships a built `dist/`, so nothing compiles on install. The
only requirement is a local Chrome — **no browser is downloaded**.

Installing from source also works, and builds once:

```bash
npm install -g github:9Ashwin/ShuaDouyin
```

This package is distributed from GitHub, not the npm registry.

<details>
<summary><strong>Other options</strong></summary>

Into a private directory, without a global npm:

```bash
curl -fsSL https://raw.githubusercontent.com/9Ashwin/ShuaDouyin/main/scripts/install.sh | sh
```

Uninstall:

```bash
npm uninstall -g shuadouyin
```

Uninstalling keeps the bot, memories and account login in `~/.dy`.

</details>

Install the skill for an agent (optional):

```bash
dy skill install
```

## Getting started

```bash
dy init                      # create the workspace, start onboarding
dy onboarding show           # four questions: name, voice, facts about you, limits
dy auth login                # open Chrome and scan the QR code
dy feed next                 # next work in the recommended feed
dy video info                # read the current work
```

The first login opens a dedicated Chrome window whose profile lives in
`~/.dy/chrome`. That login is kept across restarts.

Run `dy tui` when you want to browse and like by hand — a terminal interface
over the same operations. It shares the CLI's implementation, so both see the
same state. It needs a real terminal and refuses `--dry-run`.

## What it does

| Task | Commands |
| --- | --- |
| Browse the feed | `dy feed open` / `dy feed next` / `dy video info` |
| Read works and comments | `dy video info` / `dy comment list` / `dy comment replies` |
| Interact | `dy video like` / `dy video favorite` / `dy comment post` / `dy comment reply` |
| Direct messages | `dy chat list` / `dy chat read` / `dy chat send` / `dy chat image` |
| People | `dy user get` / `dy user search` / `dy user followers` / `dy user follow` |
| Live rooms | `dy live info` / `dy live chat` / `dy live say` / `dy live gift` |
| Search | `dy search` / `dy user search` |
| Memory and persona | `dy memory add` / `dy memory search` / `dy context show` |
| Browsing rounds | `dy browse start` / `dy browse watch` / `dy browse end` |
| Relationships | `dy social goal` / `dy social list` / `dy social due` / `dy social log` |
| Teach an agent to use it | `dy guide` |

See `dy schema` for every command, or `dy <command> --help`.

## For agents

`dy` is built for an agent to drive. Hand it to anything that can run a shell:

```bash
dy guide      # the full usage guide (~9000 characters); this is what the agent reads
```

Or install `skills/dy` into your agent's skill directory. It carries five
references: browsing and growth, memory and persona, reports, what to do when
something fails, and **platform facts** — the last one is the record of what
this project got wrong on the real page, and reading it saves repeating that.

## Principles

- **No judgement.** The CLI returns facts and candidates; the caller decides.
  It acts on a real account, so the code's job is to make every action auditable
  and reversible — not to decide whether the action is appropriate.
- **A receipt before anything leaves.** Every write lands on disk before it can
  dispatch, and replaying a request ID returns the original receipt. A
  `delivery_uncertain` write is never retried automatically: it may already be
  out, and sending again makes two.
- **Identity is a stable id.** Display names collide and change; `sec_uid` does
  not.
- **Report what is readable.** The live picture is a canvas with no text layer,
  so nothing is claimed about it. Comment lists are sampled and say so.
- **Memory belongs to the account.** A new install is a new bot; it does not
  inherit anyone else's conclusions.

## Reset

```bash
dy bot reset           # show what would be cleared
dy bot reset --write   # back up to ~/.dy-backup-<time>, then clear
dy init                # create a fresh bot
```

The Chrome login is kept, so no new scan is needed.

## Development

Requires Node.js 22.19+, pnpm, and a local Chrome.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test            # unit tests
pnpm test:browser    # isolated Chrome tests
pnpm check           # Biome + tsc
```

Output contracts, receipt states and storage semantics are in
[docs/contracts.md](docs/contracts.md). Source layout, module ownership and the
check sequence are in [AGENTS.md](AGENTS.md).

## Risks and limits

This tool drives a real Douyin account. Using it means accepting the following:

- **The account risk is yours.** Automated use of Douyin may trigger human
  verification, rate limits or penalties. The project offers no bypass and will
  not help you evade them. When a challenge appears, a person has to solve it in
  the headed Chrome window.
- **What is sent cannot be taken back.** Comments, direct messages, danmaku and
  gifts are public and irreversible, and gifts cost real money. Check the target
  and the text first; `--dry-run` shows the plan without acting.
- **Local state is sensitive.** `~/.dy` holds the login, everything that was read
  and the long-term memory. Do not commit it, screenshot it or put it somewhere
  shared. See [SECURITY.md](SECURITY.md).
- **What you read is not everything.** Lists are sampled and say
  `complete: false`; the live picture is a canvas with no text. Concluding from a
  sample is your judgement, not the tool's finding.
- **It does not decide.** Whether to send, to whom, or whether a person is worth
  knowing is not a decision the commands make, and being driven by an agent does
  not lower that bar.

## Status

Early. Commands, error codes and response fields are public contracts and are
kept stable; the database schema migrates with each release. CI runs the unit
and isolated-Chrome tests on Ubuntu, macOS and Windows.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately per
[SECURITY.md](SECURITY.md).

## License

MIT
