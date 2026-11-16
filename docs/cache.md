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

OMP changes history that it already sent in three cases:

- **An interrupted reply.** When you stop a turn, OMP removes the interrupted assistant message from the next request.
- **A rewritten tool result.** OMP later replaces some tool results, for example with `[Uneventful result elided]`.
- **A removed image.** OMP sends a maximum of five images in one request to a provider that is not in its catalog. A compaction summary uses all five. When the model then reads an image, OMP removes the oldest image, which is in the first message of the history. The remaining part of the request after the system prompt becomes uncached. This occurs again for each new image.

Each change ends the cached prefix at that message. The plugin keeps the histories that it sent and compares each new request with them. It puts a removed message back in its position, and it gives a changed message its first form. Thus a request can carry more than five images. Kimi K3.1 on Morph accepted 60 images in one request.

The plugin writes each change to a journal at `<agent dir>/cache/morph-wire/<session>.jsonl`. A restarted process reads the journal and applies the same changes.

As a result, the cache stays valid when you stop a turn, steer the agent, rewind, or branch.

## The system prompt and the tool list keep their bytes

OMP builds the system prompt and the tool list again during a session. For example, an MCP server connects and the list of mounted devices becomes longer, or a mode ends and its tool goes away. The system prompt and the tool list are the first part of the request, so one changed line makes the full request uncached.

The plugin keeps the system prompt and the tool list that a conversation first sent. When OMP changes one of them, the plugin sends the change one time in a `<system-notice>` user message at the end of the history. The notice contains these items:

- The added lines and the removed lines of the system prompt.
- The tools that are not available now, with an instruction not to call them.
- The added lines and the removed lines of each changed tool description.

A tool that is not available stays in the tool list of the request.

The plugin cannot keep the first tool list in one case: a request has a new tool, or a tool has new parameters. The model can only call a tool that the request declares. Thus the plugin sends the current tool list, and that request is uncached.

A compaction starts a new history. The first request after a compaction carries the current system prompt and the current tool list.

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
- **A new tool.** A new tool, or new parameters for a tool, make one request uncached. The log shows `Morph request prefix changed`.
- **A compaction.** A compaction replaces the history, so the first request after it is uncached. OMP can do a compaction when it starts a session again.
- **Agent Runs on Kimi K3.** Morph documents Agent Runs for Kimi K3.1. The plugin also sends the `run_id` with Kimi K3 requests.

## What the tests cover

The provider, the request settings, and the log records ran against Morph through `omp` 18.20.2.

Tests and replays of captured requests cover the history restore, the image restore, and the freeze of the system prompt and the tool list. A replay of 450 requests from a session on 16 November had 31 requests with a changed history. With the image restore, each request continued the bytes of the request before it. No live session used the image restore or the tool-list freeze yet.

Tests cover the login function. The OMP login screen did not run it yet.
