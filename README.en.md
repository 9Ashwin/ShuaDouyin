<div align="right">
  <span>[<b>English</b>]</span>
  <span>[<a href="./README.md">简体中文</a>]</span>
</div>

<div align="center">

# ShuaDouyin · 刷抖音

<img src="docs/assets/shuadouyin-hero.png" alt="ShuaDouyin: browsing and search, comments and reactions, chat and sharing, live rooms, relationships, persona and memory" width="100%" />

**Let your AI Agent use Douyin with a persona and a memory.**

A local command-line tool connecting your Agent, the Douyin page, and context that lasts.

<img src="https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white" alt="Node.js 22.19+" />
<img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
<img src="https://img.shields.io/github/stars/9Ashwin/ShuaDouyin?style=social" alt="GitHub Stars" />

[Quick start](#quick-start) · [Capabilities](#capabilities) · [Agent integration](#agent-integration) · [Development](#development-and-contributing)

</div>

## What is this?

ShuaDouyin's executable is `dy`. Give it to an AI Agent that can run shell commands to search content, inspect works and comments, interact with your authorization, handle messages and shares, visit live rooms, and keep sourced memories and relationship records.

**You define the name, voice and boundaries. The Agent interprets and decides; `dy` supplies operations and evidence.** It bundles no model and schedules no tasks. It uses your existing Agent and local Chrome, with persona and memory stored locally across sessions.

## Quick start

You need **Node.js 22.19+, Chrome, and an Agent that can execute shell commands**.

### 1. Install the CLI and skill

```bash
npm install -g shuadouyin
dy --version
dy skill install
```

The npm package is `shuadouyin`; the command is `dy`. The published package includes the build output and uses your local Chrome, without downloading another browser. The skill installer detects supported Agent directories and preserves existing copies it does not manage.

### 2. Create the workspace and log in

```bash
dy init
dy auth login
```

Scan the login QR code in the dedicated Chrome window. The default workspace is `~/.dy`; the browser login persists in `~/.dy/chrome`.

### 3. Start a conversation with your Agent

> Use dy to help me set up a name, voice and boundaries. Then browse five works, pick one to inspect its frames and comments, and tell me what you observed. Only read this round; do not interact.

You can also start with a specific task:

- **Research content:** “Search for AI coding, inspect two works, and separate what their titles, frames and comments tell us.”
- **Continue a conversation:** “Check new messages in the conversation I specify and draft a reply using the earlier context.”
- **Follow up:** “Review the people I have recorded and list follow-ups due today.”
- **Review the day:** “Summarize today's local activity and receipts, clearly separating uncertain outcomes.”

For manual terminal use, run `dy tui`. It needs an interactive terminal and shares the CLI's operations and state.

## Capabilities

![Six-panel comic: define a persona, search and browse, inspect works and comments, interact and share, visit live rooms, keep memory and relationships](docs/assets/shuadouyin-workflow.png)

The artwork uses Chinese labels. The character represents a configurable Agent, not a fixed persona. Four sample positions and five comments came from an actual browsing run; the scenes are redrawn illustrations. The other panels show capabilities, not messages or gifts sent during that run.

| Capability | Common entry points |
| --- | --- |
| Search works and people; browse a batch of feed items | `dy search` · `dy user search` · `dy feed sweep` |
| Read works, sample frames, inspect comments and replies | `dy video digest` · `dy comment list` · `dy comment replies` |
| Like, favorite, follow, post text or image comments | `dy video like` · `dy video favorite` · `dy user follow` · `dy comment post` · `dy comment image` |
| Read messages, send text and images, quote a reply | `dy chat read` · `dy chat send` · `dy chat image` · `dy chat reply` |
| Share a work as a link or native card | `dy chat share` · `dy chat forward` |
| Read live-room info and chat, speak, send a named and priced gift | `dy live info` · `dy live chat` · `dy live say` · `dy live gift` |
| Read persona, recall context, save sourced facts | `dy persona show` · `dy context show` · `dy memory add` |
| Derive voice from actual writing, retain lessons, check wording | `dy persona evolve` · `dy learn keep` · `dy voice check` |
| Track browsing rounds, goals, relationships and follow-ups | `dy browse start` · `dy social goal` · `dy social due` |
| Inspect write receipts; prepare and save daily reports | `dy receipt get` · `dy report prepare` · `dy report save` |

These are command entry points. Use `dy <command> --help` for required arguments, or `dy schema` for the complete command and field catalog.

## Persona and memory across sessions

The default `~/.dy` workspace separates persona, people records, memory and the browser login:

- **`AGENTS.md`** defines the Agent's identity, voice and boundaries. You can revise the settings.
- **`PROFILES.md` and `memory/`** hold people records and sourced memories. Owner statements, page observations and inferences stay distinct. Markdown is the source of truth for memory bodies.
- **`growth review`, `learn keep` and `persona evolve`** support reviewing activity, retaining lessons and deriving changes in voice. The caller decides what is worth keeping; a viewed work does not automatically become a lasting preference.

Updating or reinstalling the CLI continues to use the existing workspace. Use the reset commands below when you want to start over.

## Agent integration

The [dy skill](skills/dy/SKILL.md) teaches Agents to use the tool, with topic-specific workflows in [references](skills/dy/references/). As an alternative to `dy skill install`, use the skills installer:

```bash
npx skills add https://github.com/9Ashwin/ShuaDouyin --skill dy
```

Start each task by reading persona and relevant context:

```bash
dy persona show
dy context show --query "The question for this task"
dy feed sweep --count 5
```

Choose a work ID from the results, open its detail page, then sample it:

```bash
dy video open <video-id>
dy video digest --video-id <video-id> --limit 5
```

`dy guide` returns instructions matching the installed version; `dy schema` describes commands, arguments and effects. Run one workspace operation at a time to avoid account-lock conflicts.

Success emits `{ok:true,data}` to stdout. Failure emits `{ok:false,error}` to stderr and exits nonzero. Writes use a unique `--request-id`. The `--dry-run` option validates input and the plan without connecting to Chrome, filling inputs or sending. See [docs/contracts.md](docs/contracts.md) for the full contract.

## Actions and evidence

- **A receipt before dispatch.** Replaying a confirmed request ID returns the saved receipt. Inspect `delivery_uncertain` outcomes instead of automatically resending. Native-card sharing currently cannot verify delivery and keeps dispatched shares uncertain.
- **Stable identities.** Use the work, user and conversation IDs returned by the CLI. Display names are only labels.
- **Samples are not full viewing.** Lists contain loaded content and generally report `complete: false`. The live picture is not returned as readable content. The Agent draws conclusions from the evidence it actually has.
- **External actions need authorization.** Comments, messages, follows and live chat affect a real account. Gifts cost money and require explicit agreement plus a name-and-price check. Deletion and recall depend on platform conditions and cannot guarantee that content was unseen.
- **Local login and data.** Automation may trigger verification, rate limits or account penalties. A person must complete verification; the project offers no bypass. `~/.dy` contains login state, messages and memories and should not be committed or shared. See [SECURITY.md](SECURITY.md).

## Installation options and workspace management

<details>
<summary><strong>Other installation methods, uninstall and reset</strong></summary>

Install from GitHub source, which runs a build:

```bash
npm install -g github:9Ashwin/ShuaDouyin
```

On macOS / Linux, an installer can use a private installation directory:

```bash
curl -fsSL https://raw.githubusercontent.com/9Ashwin/ShuaDouyin/main/scripts/install.sh | sh
```

Check installed skill copies against the current version:

```bash
dy skill status
```

Remove an npm global installation while retaining `~/.dy`:

```bash
npm uninstall -g shuadouyin
```

Reset persona, memories and activity after a backup; keep the Chrome login:

```bash
dy bot reset           # preview the scope
dy bot reset --write   # back up and reset; use the returned backup path
dy init                # create the workspace again
```

</details>

## Development and contributing

Requires Node.js 22.19+, pnpm, and local Chrome.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm check           # Biome + TypeScript
pnpm test            # unit tests
pnpm test:browser    # temporary Chrome profile and fixture pages
```

Browser tests use no account credentials. Passing them does not prove behavior on the real Douyin page. The project is early, and page changes can affect operations; error codes, arguments and response fields are maintained as public contracts.

See [AGENTS.md](AGENTS.md) for development rules, [docs/architecture.md](docs/architecture.md) for the architecture, [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, and [CHANGELOG.md](CHANGELOG.md) for release changes.

## License

[MIT](LICENSE)
