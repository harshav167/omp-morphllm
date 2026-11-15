# omp-morphllm

Morph Ultra as a native provider for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP).

Morph Ultra limits uncached input tokens per minute and does not count cached input. A coding agent therefore works on Ultra only while almost every input token is a cache hit. This plugin adds the provider and keeps each session on its cached prefix.

## Install the plugin

1. Install the plugin from GitHub.

   ```bash
   omp plugin install https://github.com/harshav167/omp-morphllm
   ```

2. Start `omp`.
3. Run `/login` and select **Morph**. OMP opens the Morph API-key page.
4. Paste your API key. The plugin checks the key with Morph, and OMP saves the key in its credential store.
5. Run `/model` and select a `morph/` model.

If your `models.yml` defines a `morph` provider, remove that block. The models of the plugin replace the models of that block.

To update the plugin, run `omp plugin upgrade omp-morphllm`. The plugin requires OMP 18.20.0 or later.

## Models

The plugin adds the models that [Morph's catalog](https://www.morphllm.com/api/models/json?prices=list) marks `ultra_plan`.

| Model | ID | Reasoning efforts |
|---|---|---|
| Kimi K3.1 | `morph-kimik31` | low, medium, high, xhigh, max |
| Kimi K3 | `morph-kimik3` | low, medium, high, xhigh, max |
| DeepSeek V4.1 Flash | `morph-dsv41flash` | low, high, xhigh, max |
| DeepSeek V4.1 Flash 1017 | `morph-dsv41flash-1017` | low, high, xhigh, max |

Each model accepts text and images and has a context window of 1,048,576 tokens.

## What the plugin does

- **It pins every request setting for Morph.** OMP selects many request details from the model name, so a model named "Kimi" gets Moonshot's rules. Morph serves the weights on its own stack.
- **It keeps each session on one worker.** Every Kimi request of a session carries one Morph `run_id`.
- **It keeps the request prefix byte-stable.** When you stop a turn or connect a new tool server, OMP changes bytes that it already sent. The plugin sends the original bytes.
- **It reports the cache on every response.** The OMP log gets the cached and uncached tokens, the Ultra limit headers, and the execution region. A cache miss shows as a warning in the session.

In a session on 15 November, Morph served 98.7% of 115 million input tokens from the cache.

## More documentation

- Read [How the plugin keeps a session cached](docs/cache.md) to learn how each mechanism works and what the plugin does not handle.
- Read [Provider defaults](docs/provider-defaults.md) to find a request setting and its reason.
- Read [What a client cannot change](docs/morph-limits.md) for the cache misses that Morph causes, with request IDs.

## Development

To load a local checkout for one run, start `omp -e /path/to/omp-morphllm`.

```bash
bun install
bun test
bun run typecheck
```
