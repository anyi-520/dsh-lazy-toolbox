# dsh-lazy-toolbox — Introduction (English)

> A DeepSeek Harness plugin. It takes skills and MCP servers out of the default tool
> definitions and turns them into a toolbox you open on demand.
> Repository: <https://github.com/anyi-520/dsh-lazy-toolbox>

## In one sentence

Every request DSH sends carries the manual for "all the tools I can use". Once you install a
tool-heavy MCP server, that manual becomes tens or hundreds of thousands of tokens of fixed
overhead. This plugin takes the manual off the desk and replaces it with a toolbox: a single
`toolbox` tool stays on the desk, and a hammer is handed to the model only when it actually
needs one — then taken back.

## Why (measured numbers)

REA is a reverse-engineering MCP with 207 tools. Both columns below describe "everything in context":

| | tools | tool-definition payload | tokens (approx.) |
| --- | --- | --- | --- |
| Without the plugin | 207 | 385,025 chars | ≈ 110,000 |
| With the plugin, 3 injected | 3 | 3,121 chars | ≈ 892 |

That is a 99% cut — in money, in latency, and in the chance of the model picking the wrong tool
out of 207.

## What it does

| Capability | Detail |
| --- | --- |
| Catalog instead of schemas | The system prompt holds only one-line purposes (`skill:xxx — what it is for`), no parameters |
| Injection on demand | `toolbox { action: "load", ids: ["mcp:rea:binary_overview"] }` injects just what you need |
| Unload when done | `unload`, or automatic on turn end (`autoUnloadOnTurnEnd`) |
| Current session only | Definitions are registered in the agent scope; other sessions never see them, DSH's own config is untouched |
| New sessions are told | Each new conversation gets a runtime-context note: "N skills and M MCP servers are installed but not in your tool list" |
| Settings switches | `Settings → Lazy Toolbox`, one toggle per entry. Off = hidden from the catalog and refused by `load`, files retained |
| Move in / restore | Install-time migration pulls scattered skills and MCP rows in; uninstall puts them back exactly |
| Bundle adoption | Skills and MCP servers shipped inside other plugins (`skills/`, `mcp.json`, `dsh.skills`, `dsh.mcp`) are adopted automatically, referenced in place |
| Local run log | `logs/plugin-YYYYMMDD.log`, JSONL, every call and stack trace; never shown in Settings |
| Zero runtime deps | Its own MCP client, YAML-subset parser and schema normalizer — nothing extra to install in the profile |

## A full run (real session)

You say: "You have the lazy toolbox, right? Use REA to look at `D:\samples\a.exe`."

1. The model sees the catalog line: `mcp:rea — REA: reverse anything (207 MCP tools)…`
2. It decides what it needs and calls `toolbox { action: "load", ids: ["mcp:rea:open_binary", "mcp:rea:binary_overview", "mcp:rea:list_procedures"] }` → three definitions injected
3. It works: `open_binary` returns `pe / x86_64 / sha256 …`; `binary_overview` runs Ghidra and reports
   9 segments, 198 procedures, 153 strings; `list_procedures` lists the entry point and imports
4. It cleans up: `toolbox { action: "unload", all: true }`

## Install

```bash
git clone https://github.com/anyi-520/dsh-lazy-toolbox.git
node dsh-lazy-toolbox/bin/cli.mjs wire-profile   # junction + cordis.patch.yml row + client declaration
# restart DSH, then open Settings → Lazy Toolbox
```

Or download the [release zip](https://github.com/anyi-520/dsh-lazy-toolbox/releases/latest) and run the same command.

## CLI

```bash
node bin/cli.mjs status                # what is in the library
node bin/cli.mjs list                  # the catalog (one-line purposes)
node bin/cli.mjs discover --dry-run    # preview skills / MCPs bundled in installed plugins
node bin/cli.mjs enable skill:<name>    # same as flipping the switch in Settings
node bin/cli.mjs disable mcp:<server>   # hide it, keep the files
node bin/cli.mjs logs --lines 50       # local run log
node bin/cli.mjs doctor                # self-check
```

## Boundaries

- DSH's own configuration is untouched (apart from the single install row `wire-profile` writes);
  injection happens in the agent scope only.
- Uninstalling restores every file the install moved, unchanged.
- Skills adopted from plugins are referenced **in place**, so a plugin upgrade is picked up
  immediately and no stale copy is left behind.
- Requires DSH Desktop ≥ 0.2.1-rc.5 and Node ≥ 20. 51 tests, all green.

## Layout

```
lib/index.js      toolbox registration, catalog section, HTTP endpoint, lifecycle hooks
lib/tools.js      the resident tool's actions
lib/inject.js     per-session inject / unload
lib/discover.js   detection and adoption of plugin-bundled skills / MCPs
lib/skills.js     skill discovery, import, load, restore
lib/migrate.js    migration / restore (MCP rows + skill dirs)
lib/store.js      the library (store.json + skills/)
lib/log.js        local JSONL run log
client.js         the Settings → Lazy Toolbox browser half
test/             51 node:test cases
```

## License

MIT — see [LICENSE](../LICENSE).
