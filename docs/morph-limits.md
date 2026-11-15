# What a client cannot change

The plugin controls the bytes of a request and its placement hints. Morph decides where the request runs and how the limit counts it. This page records what Morph decided in real sessions.

All figures come from sessions with Kimi K3.1 at max reasoning.

## The cache works when the session stays in one region

| Session | Responses | Cached input tokens | Uncached input tokens | Cached share |
|---|---:|---:|---:|---:|
| 15 November | 223 | 113,994,240 | 1,451,319 | 98.7% |
| The same session without its one region move | 222 | 113,994,240 | 742,396 | 99.4% |

The 742,396 uncached tokens include the first request of the session, which has no cache. After that, a typical request carries 300 to 2,000 uncached tokens and 700,000 cached tokens.

## A run moves to another region and loses its cache

The cold request has the same bytes as the warm request, plus the new messages at the end. The `run_id`, the `x-session-id` header, and the `prompt_cache_key` are the same. The response reports a different `x-morph-execution-region` and zero cached tokens.

| Date (UTC) | Warm request | Cold request | Uncached tokens |
|---|---|---|---:|
| 11 Nov 15:28 | `sf-k31` | `rack1` | 365,862 |
| 11 Nov 15:46 | `sf-k31` | `kimik3-rewbi` | 381,942 |
| 13 Nov | `eb1d4ed9-8e30-4488-8e17-6f5d01b49fba` on `kimik3-rewbi` | `3eeb4ffe-18ae-403c-a371-50d41b273083` on `rack1` | 242,871 |
| 15 Nov 09:08 | `89ad4b9a-e743-46b4-ba35-2d833926a70b` on `sf-k31` | `3379d265-07ea-435f-b415-d74902ec0f37` on `rack1` | 708,923 |

The requests of 11 November had no `run_id`. The request of 15 November had one.

## The limit counts the move against the subscriber

The Ultra limit for Kimi is 24,290 uncached input tokens per minute. A request of 708,923 uncached tokens uses 29 minutes of that limit. During that time, each new request gets a `429` or waits.

On 10 November the published limit was 72,870 tokens per minute. The same request used 10 minutes of that limit.

## A client cannot select a region

An `x-morph-execution-region` request header has no effect. The region names do not resolve as host names. Morph documents placement by `x-session-id` and by `run_id` as best effort.

## A throttled request can wait without an answer

Some throttled requests waited about 300 seconds and received no response headers. Other throttled requests received a `429` with `Retry-After`.

The cause is an inference from timing. Each long wait occurred when the uncached allowance was short.

## What helps

- A way to pin a run to a region or a worker.
- No charge against the uncached limit for a prefill that a region move caused.
- A `429` with `Retry-After` at once when the limit throttles a request.
