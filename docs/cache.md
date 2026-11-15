# How the plugin keeps a session cached

Morph's cache matches a request from its first byte. One changed byte ends the cached prefix at that byte. The cached prefix is in the memory of one worker, so the request must also reach that worker.

A client controls the bytes that it sends and the placement hints that it sends. The plugin handles both, and it measures the result on every response.

## One run for each session

Every Kimi request of a session carries `run_id: omp-<session id>`. Morph gives `run_id` precedence over `x-session-id` and schedules the run on the worker that holds its cache.

The id does not change during tool turns, retries, side requests, follow-up prompts, rewinds, branches, or a restarted process. Side requests share the id because they carry the same prefix.

The plugin releases the run with Morph's final request (`run_final: true`) in three cases:

- You switch to another session.
- OMP exits.
- The agent is idle for 10 minutes.

Morph reclaims an idle run after 15 minutes. That reclaim covers a process that stops without a release.

The plugin leaves a request unchanged when the request already has a `run_id` or a `program_id`.

## Sent history keeps its bytes

OMP changes history that it already sent in two cases:

- **An interrupted reply.** When you stop a turn, OMP removes the interrupted assistant message from the next request.
- **A rewritten tool result.** OMP later replaces some tool results, for example with `[Uneventful result elided]`.

Each change ends the cached prefix at that message. The plugin keeps the histories that it sent and compares each new request with them. It puts a removed reply back in its position, and it gives a rewritten tool result its first form.

The plugin writes each change to a journal at `<agent dir>/cache/morph-wire/<session>.jsonl`. A restarted process reads the journal and applies the same changes.

As a result, the cache stays valid when you stop a turn, steer the agent, rewind, or branch.

## The system prompt keeps its bytes

OMP builds the system prompt again during a session. For example, an MCP server connects and the list of tools becomes longer. The system prompt is the first part of the request, so one changed line makes the full request uncached.

The plugin keeps the system prompt that a conversation first sent. When OMP changes the system prompt, the plugin sends the added lines and the removed lines one time. They go in a `<system-notice>` user message at the end of the history.

A compaction starts a new history. The first request after a compaction carries the current system prompt.

## Every response reports the cache

The plugin writes these records to the OMP log:

| Record | Content |
|---|---|
| `Morph response` | Status, request ID, execution region, and the `x-morph-ultra-*` limit headers |
| `Morph usage` | Cached and uncached input tokens, and the share that the plugin expected to be cached |
| `Morph cache miss` | A request that the plugin expected to be cached, and that was not |
| `Morph request prefix changed` | The system messages or the tool list in the request changed |

A cache miss also shows as a warning in the session. The status line shows the cached share, the new tokens, and the remaining allowance.

## What the plugin does not handle

- **The system notice is a user message.** Until the next compaction, the model reads a changed instruction as a notice and not as system prompt.
- **A changed tool list.** The plugin records the change as `Morph request prefix changed` and sends the new list.
- **Agent Runs on Kimi K3.** Morph documents Agent Runs for Kimi K3.1. The plugin also sends the `run_id` with Kimi K3 requests.

## What the tests cover

The provider, the request settings, and the log records ran against Morph through `omp` 18.20.2.

Tests and replays of captured requests cover the history restore and the system-prompt freeze. No live session used them yet.

Tests cover the login function. The OMP login screen did not run it yet.
