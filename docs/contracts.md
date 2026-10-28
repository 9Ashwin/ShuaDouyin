# Command contracts

`dy schema` is the canonical command/flag catalog. JSON fields are versioned by `schema_version:1` in the schema response.

## Output and exits

- Successful operations emit exactly one `{ok:true,data}` JSON object to stdout and exit 0.
- Failures emit exactly one `{ok:false,error}` JSON object to stderr; stdout stays empty.
- `error.type` and `error.code` are stable machine fields. `message` and `hint` are explanatory. `retryable:false` means the CLI offers no automatic replay promise.
- Exit codes: 1 internal, 2 validation, 3 authentication/verification, 4 browser/timeout, 5 local or page state, 6 uncertain delivery/key conflict, 130 cancellation.
- `--format pretty` changes indentation. Help/version and TUI are explicit non-JSON presentation modes.
- `--dry-run` emits the validated operation plan and sets top-level `dry_run:true`. It does not connect Chrome, fill inputs, create state or send anything. Reading an explicitly supplied text file/stdin is allowed.

## Writes

Comments and messages require a caller-supplied request ID. The fingerprint binds the exact target, text, reply anchor and desired value. Confirmed IDs replay locally without contacting Chrome. Different input with the same ID fails with `idempotency_conflict`.

Receipt states are `prepared`, `dispatching`, `confirmed` and `not_sent`. A receipt is durably saved as `dispatching` before the external input. Interruption after that point is treated as uncertain. `prepared` remaining after a crash is also conservatively treated as uncertain; `not_sent` records a known pre-dispatch failure.

A send is confirmed only by a new matching own record with a stable ID, no pending/failure marker, and cleared input observed twice. This is page-level evidence; it is not a platform delivery SLA. Toggles require the requested state to be observed twice. Unclear controls or conflicting identity fail closed.

Each profile holds one cross-process lock. Chrome uses a dedicated user-data directory and a loopback-only debugging port. The CLI validates the endpoint identity and persists its owned target ID. Closing a command detaches from Chrome; `browser stop` closes the dedicated browser.

## Lists and captures

Lists collect visible loaded DOM rows, de-duplicate by ID and obey caller-selected record/scroll bounds. They always report `complete:false`; no API cursor or total count is invented.

Captures return absolute local paths and observed state. Observation samples frames without interpreting them. Audio captures only a video audio track and performs no transcription.


## Bot and memory storage

Default state lives under `~/.dy`, which is the bot workspace itself: one
installation holds one bot. Persona, people profiles, memories, reports, the
event log and the browser profile all sit at that root. Browser commands resolve
the workspace before opening Chrome.

The local SQLite schema is versioned by migrations/0001_workspace.sql and opened with foreign keys, WAL and a busy timeout. Connections are closed after each local database operation. Markdown is authoritative for current memory bodies. Revision archives are not rebuildable indexes.

Memory files carry YAML frontmatter and a stable UUID. Layers are preference, identity, context, experience, activity, persona, relationship and note. Types are memory, observation, insight and profile: an observation is something that happened, an insight is a conclusion drawn from several of them, and keeping them apart is what lets a profile cite its evidence. Search reconciles all bot files, builds an FTS5 trigram index, and uses literal matching for short queries. Reconciliation parses every file before replacing any index rows. Exact text matching is not semantic inference.

Frontmatter omits a field that has no value rather than writing `tags: []` or `profile_ref: ""`; every omitted key decodes back to the same default. A title is derived from the topic, then the first body line, and only then the subject — a title taken from the subject made every memory about a person appear under a stable ID. A title that equals the derived one is re-derived on the next edit; a title a person wrote is kept.

File replacement is atomic; file write and SQLite update are separate operations. Interrupted synchronization is repaired by reconciliation, rather than claiming a cross-filesystem transaction. Updating a memory or existing workspace/report file requires the current revision. Conflicts return revision_conflict without overwriting user content. revision_required asks the caller to read first. MEMORY.md is a generated navigation surface.

No external model is called by memory, context or report commands. Sources, certainty and confidence are caller-provided claims. Context documents are data subordinate to the calling agent's system instructions and current user task.

Context output returns explicit excerpts for long bodies and marks truncation; full reads retain the source text. MEMORY.md navigates the newest 200 records, while list/search can retrieve the stored collection. These presentation bounds do not limit the number of saved memories.
