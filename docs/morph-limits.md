# What a client cannot change

The plugin controls the bytes of a request and its placement hints. Morph decides where the request runs and how the limit counts it. This page records what Morph decided in real sessions.

All figures come from sessions with Kimi K3.1 at max reasoning.

## The cache works when the session stays in one region

| Session | Responses | Cached input tokens | Uncached input tokens | Cached share |
|---|---:|---:|---:|---:|
| 15 November | 293 | 170,322,816 | 1,655,132 | 99.0% |
| The same session without its one region move | 292 | 170,322,816 | 946,209 | 99.4% |

The 946,209 uncached tokens include the first request of the session, which has no cache. After that, a typical request carries 300 to 2,000 uncached tokens and 700,000 cached tokens.

## A run moves to another region and loses its cache

The cold request has the same bytes as the warm request, plus the new messages at the end. The `run_id`, the `x-session-id` header, and the `prompt_cache_key` are the same. The response reports a different `x-morph-execution-region` and zero cached tokens.

| Date (UTC) | Warm request | Cold request | Uncached tokens |
|---|---|---|---:|
| 11 Nov 15:28 | `sf-k31` | `rack1` | 365,862 |
| 11 Nov 15:46 | `sf-k31` | `kimik3-rewbi` | 381,942 |
| 13 Nov | `eb1d4ed9-8e30-4488-8e17-6f5d01b49fba` on `kimik3-rewbi` | `3eeb4ffe-18ae-403c-a371-50d41b273083` on `rack1` | 242,871 |
| 15 Nov 09:08 | `89ad4b9a-e743-46b4-ba35-2d833926a70b` on `sf-k31` | `3379d265-07ea-435f-b415-d74902ec0f37` on `rack1` | 708,923 |

The requests of 11 November had no `run_id`. The request of 15 November had one.

On 15 November the run went back to `sf-k31` after 12 requests on `rack1`. The first request after the return read 707,712 cached tokens. The cache on `sf-k31` stayed alive during the move.

## The limit counts the move against the subscriber

The Ultra limit for Kimi is 24,290 uncached input tokens per minute. A request of 708,923 uncached tokens uses 29 minutes of that limit. During that time, each new request gets a `429` or waits.

On 10 November the published limit was 72,870 tokens per minute. The same request used 10 minutes of that limit.

## A client cannot select a region

An `x-morph-execution-region` request header has no effect. The region names do not resolve as host names. Morph documents placement by `x-session-id` and by `run_id` as best effort.

## A throttled request looks like a slow request

Morph answers a throttled request with a `429` and a `Retry-After` of at most 59 seconds. The body gives only the limit: `Limit: 24290 uncached input tokens/minute`. OMP 19.0.0 retries a `429` without a sign when `Retry-After` is 60 seconds or less (`fetchWithRetry` in `@oh-my-pi/pi-utils`), up to five times, within the 300-second wait for the first response. The waits of about 300 seconds without response headers were these retries. Only the last `429` of a series reaches the OMP log, as `agent turn ended with provider error`.

## Morph charges a large miss at different times

In the OMP logs of 15 to 18 November, 44 requests had more uncached tokens than the per-minute allowance and the burst together (97,160). After 23 of them the next request waited for a time that fits the miss. After one, the wait of 1,551 seconds followed three misses in 22 seconds. After 17 of them Morph admitted the next request within 120 seconds. After the other 3 the session was idle for hours.

- Some misses caused a wait several requests later. A miss of 470,139 tokens on 16 November caused a wait of 1,110 seconds nine requests later.
- Some misses caused no wait. After a miss of 427,780 tokens on 16 November, 27 requests in the next 30 minutes had no wait.

When a wait came at once, it lasted a median of 0.92, and at most 1.0, of the miss divided by 24,290 tokens per minute (23 waits). The limit headers do not show the debt: `x-morph-ultra-uncached-input-remaining` stops at 0.

## What helps

- A way to pin a run to a region or a worker.
- No charge against the uncached limit for a prefill that a region move caused.
- A `Retry-After` that gives the real wait. Above 60 seconds, OMP passes the `429` to the session at once instead of retrying it without a sign.
