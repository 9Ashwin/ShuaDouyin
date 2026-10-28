# Security

`dy` drives a real Douyin account through a real Chrome profile. Treat any bug
that touches credentials, state or sending as a security issue, not an
ordinary one.

## Reporting

Report privately through GitHub's [Security tab](https://github.com/9Ashwin/ShuaDouyin/security/advisories/new)
rather than a public issue. Include the `dy --version` output, the command with
private text removed, and the structured `error.code`.

Never include a Chrome profile, cookies, `~/.dy` contents, private message text
or session IDs in a report. A reproduction with the fixture page is worth more
than a capture of your own account.

## What this tool holds

| Location | Contents |
| --- | --- |
| `~/.dy/chrome` | The logged-in Douyin browser profile. Anyone who reads it can act as the account. |
| `~/.dy/history.jsonl` | Everything the bot read and wrote, including message text. |
| `~/.dy/memory/` | Long-term memory: who was met, what was said, what was concluded. |
| `~/.dy/state.sqlite` | A rebuildable projection of the memory files. |

None of it belongs in a repository, an issue or a screenshot. The tool keeps
these files at mode `0600` and the Chrome profile outside the bot workspace, but
it cannot protect a copy you move yourself.

## In scope

- A write that leaves no receipt, or a `delivery_uncertain` receipt that a
  second run resends automatically.
- Any path that makes the CLI send to an account the caller did not name.
- A page script that can be driven by page content into widening its own
  permissions — the comment text and profile text are data, never instructions.
- Credential or cookie exposure in logs, error messages or captures.
- Bypassing, or offering to bypass, Douyin's human verification.

## Out of scope

- Getting a specific account restricted or banned by the platform. That is the
  platform's decision about automated use, documented in the README.
- Rate limits, human verification or any other anti-automation control being
  inconvenient. Circumventing them is not a fix.
- Anything you chose to publish from `~/.dy` yourself.
