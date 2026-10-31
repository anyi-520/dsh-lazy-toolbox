# dsh-lazy-toolbox

<!-- repo-links -->
> Repository: <https://github.com/anyi-520/dsh-lazy-toolbox> · Install:
> ```bash
> git clone https://github.com/anyi-520/dsh-lazy-toolbox.git
> node dsh-lazy-toolbox/bin/cli.mjs wire-profile
> ```
> Or grab the [release zip](https://github.com/anyi-520/dsh-lazy-toolbox/releases/latest) and run the same command; `dsh plugin add dsh-lazy-toolbox` works once it is on npm.

> Stop pushing every skill and MCP tool definition into every conversation. Keep a catalog, hot-load on demand.

DeepSeek Harness (DSH) ships the full tool definition — name, description, JSON schema — of every skill
and every MCP server into every single request. The more you install, the more tokens you burn and the
noisier tool selection becomes.

`dsh-lazy-toolbox` changes that:

1. **Moves them out.** On install it takes local skill directories and the profile's `mcp-client` rows into
   its own store, so DSH stops advertising them globally. On uninstall it puts the original text back.
2. **Keeps a catalog.** One system-prompt block lists skills and MCP servers separately, one sentence of
   purpose each, with **no parameter schemas**.
3. **Hot-loads per conversation.** When the model needs one, it calls `toolbox`; the definition is registered
   into the **current agent scope only**. `unload` (or the end of the turn) removes it again.

## Install

```bash
# local checkout
dsh-lazy-toolbox wire-profile     # bundles + insert row + node_modules link, idempotent
# restart dsh; the first start migrates local skills and MCP config
```

```bash
# from npm
npm i -g dsh-lazy-toolbox && dsh-lazy-toolbox wire-profile
```

Manual equivalent:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- insert:
    - id: lazy-toolbox
      name: dsh-lazy-toolbox
      inject: [systemPrompt, tools]
      config:
        autoImport: true
        autoUnloadOnTurnEnd: true
```

plus `"dsh-lazy-toolbox"` in `package.json` `dsh.profile.bundles` and a `link:`/version dependency.

## The `toolbox` tool

| action | effect |
| --- | --- |
| `status` | store summary, what this session loaded, pending restores |
| `list` | the catalog; `ids: ["mcp:<server>"]` expands that server's tools |
| `load` | inject `ids` into the **current session**; a skill returns its body inline |
| `unload` | remove injected definitions (`all: true` for everything) |
| `add_skill` | import from a local path, an http(s) `.md` URL, or a git repo |
| `add_mcp` | register an MCP server and verify it by connecting first; rolls back on failure |
| `remove` | delete a skill / MCP entry from the store |
| `enable` / `disable` | turn one skill or MCP server on / off — the same switch the settings page shows |

> The external toolchain panel (JDK / Ghidra / rea-agents / JADX / IDA) has been split into a
> separate plugin, **`dsh-toolchain`**, with its own `toolchain` tool and its own
> `Settings → 工具链` page. `toolbox` no longer exposes `requirements` / `install`.

`add_skill` and `add_mcp` both require a one-sentence `summary` — that line becomes the catalog entry.

## Settings → Lazy Toolbox: on/off switches

The first card of the plugin's settings section lists every skill and every MCP server (two
groups), each row showing the name, its one-sentence purpose, tool count / origin, and a switch.
Switching one off means:

- it disappears from the system-prompt catalog, so the model is no longer told it exists;
- `toolbox action="load"` refuses it explicitly ("turned off in settings") instead of loading anyway;
- its files and configuration stay on disk (`disabled.skills` / `disabled.mcp` in `store.json`),
  and one click brings it back.

The panel and the AI read one fact: `GET /dsh-lazy-toolbox/api` returns `inventory`,
and a switch flip is `POST {"op":"toggle","id":"skill:<name>","enabled":false}`.

## Lifecycle

| When | What |
| --- | --- |
| plugin start | migrate `mcp-client` rows, `$DSH_HOME/skills`, `~/.agents/skills` (project dirs optional) |
| every pre-step | throttled scan: skills the model just downloaded and new `mcp-client` rows are moved in automatically |
| turn end | unload this session's injected definitions (`autoUnloadOnTurnEnd`) |
| agent disposed | drop its injections, close idle MCP connections |
| plugin uninstall | `preuninstall` restores every skill and MCP row, then unwires the profile |

**Restore semantics**: MCP rows are stored as the **original text block plus its original line index** and
written back in place; skill directories are moved back to their origin. Files are backed up as
`<file>.lazy-toolbox-backup` before external edits are reverted. Name collisions are skipped and reported,
never overwritten.

## Config

```yaml
config:
  dataDir: ""                     # default $DSH_HOME/lazy-toolbox
  autoMigrate: true
  autoImport: true
  autoImportProjectSkills: false
  scanIntervalMs: 5000
  autoUnloadOnTurnEnd: true
  mcpIdleMs: 60000
  maxCatalogItems: 200
  autoDetectPluginAssets: true     # adopt skills / MCPs bundled in plugins
  logEnabled: true                # local run log, file only (never shown in Settings)
  logDir: ""                      # default $DSH_HOME/lazy-toolbox/logs
  logLevel: info                  # debug | info | warn | error
  logMaxBytes: 2097152            # per-file cap, overflow rolls to .1 .2 …
  logRetentionDays: 14            # 0 disables pruning
```

## Bundled skills and MCP servers (auto-adopted)

Plugins often ship their own capabilities: a `skills/` directory, an `mcp.json`, or
`dsh.skills` / `dsh.mcp` inside `package.json`. Since 0.5.2 the toolbox registers those
into its own library automatically, so they show up in the catalog and can be `load`ed
like anything else.

- Scanned at startup and on every refresh (fingerprint-based, unchanged trees are skipped).
- **Referenced in place** — nothing is copied, so a plugin upgrade is picked up immediately.
- Idempotent; entries are pruned when the plugin disappears; `disable` / `remove` wins over re-adoption.
- Opt out per plugin with `"dsh": { "autoDetect": false }`.
- Run it manually with `node bin/cli.mjs discover [--dry-run]` or `toolbox { action: "discover" }`.

Full matrix of supported layouts: [docs/plugin-assets.md](docs/plugin-assets.md) (Chinese);
skeleton example: [examples/plugin-with-skill/](examples/plugin-with-skill/).

## Run log (local only)

Every functional call and failure is appended as JSONL to
`$DSH_HOME/lazy-toolbox/logs/plugin-YYYYMMDD.log`. Nothing is surfaced in Settings.

| event | what it records |
| --- | --- |
| `plugin.start` / `plugin.stop` | version, data dir, effective config, uptime |
| `toolbox.call` | every `toolbox` call: `action`, `ids`, `ok`, `ms`, plus `error.stack` on failure |
| `toolbox.failed` | write actions rejected by `guard()` |
| `inject.load` / `inject.unload` | per-id injection/removal result and tool-definition count |
| `mcp.connect` / `mcp.close` | server, transport, command, and connection errors |
| `api.request` | Settings HTTP calls: method, op, id, status, latency |
| `scan.failed` / `migrate.*` | auto-import and migration outcomes |

Logging never throws (a broken log must not break the plugin), long values are truncated to 2000 chars,
files rotate per day and per size, and old files are pruned by `logRetentionDays`.
Inspect with `dsh-lazy-toolbox logs [--lines N] [--raw] [--path]`.

## CLI

```bash
dsh-lazy-toolbox status | list | doctor | discover [--dry-run]
dsh-lazy-toolbox migrate [--dry-run] [--project]
dsh-lazy-toolbox restore [--skills-only|--mcp-only]
dsh-lazy-toolbox add-skill <path> [--name n] [--summary "one line"]
dsh-lazy-toolbox add-mcp <name> --command npx --args "-y some-mcp" [--verify]
dsh-lazy-toolbox remove skill:<name>|mcp:<server>
dsh-lazy-toolbox wire-profile | unwire-profile [--profile <dir>]
```

## Why per-session isolation works

DSH's tool registry is layered by agent scope (`@deepseek-ai/dsh-scope`). A definition registered through
`agent.ctx.tools.register(def)` is visible only to that agent and returns an exact disposer; the whole scope
is reclaimed when the agent is disposed. The plugin never touches the global registry, so session A loading
a server is invisible to session B.

## Design notes

- **Zero runtime dependencies**: the MCP client (stdio + streamable-http), a YAML subset reader and the schema
  normalizer live in this repo. Nothing imports `@deepseek-ai/*`; all DSH interop goes through `ctx` services.
- **Lossy schema downgrade**: DSH accepts only `type/oneOf/properties/required/additionalProperties/items/enum/const`
  plus annotations; upstream `$ref`, `anyOf`, `format` would be rejected, so they are dropped instead of failing
  the whole server.
- **Uninstall means uninstall**: user files are moved, never deleted.

## Compatibility

DSH Desktop 0.2.1-rc.x. Node.js >= 20.

## Tests

```bash
node --test --test-force-exit "test/*.test.mjs"   # 21 tests, real stdio MCP fixture included
```

## License

MIT — see [LICENSE](LICENSE).
