# oh-my-openagent-v2-bridge

Run the **complete V1 `oh-my-openagent` (oh-my-opencode) engine on OpenCode V2**.

OpenCode V2 intentionally broke the plugin API: a V1 plugin returned one object of
tools and hooks, while V2 expects `{ id, setup }` and hands the plugin a different
context. The upstream engine still ships the V1 shape, so V2 refuses to load it
(`Plugin must export a default definition with an id and an effect or setup
function`).

This bridge does not reimplement the engine. It drives the **unmodified published
engine** through a V1-shaped facade built on the V2 context, then translates the
V1 tools and hooks back into V2 registrations. The engine keeps owning its tools,
agents, commands, MCP servers, skills, background tasks and hooks.

```
OpenCode V2 ── setup(ctx) ──► bridge
                                │
                                ├─ compat client  : V1 `{path,query,body}` + `{data,error}`  ─► V2 ctx domains
                                ├─ engine.boot    : pluginModule.server(v1Input) ────────────► V1 hooks + tools
                                │
                                ├─ tool bridge    : V1 zod ToolDefinition ──────────────────► ctx.tool.transform
                                ├─ config bridge  : mutated V1 config ─────────────────────► ctx.agent/command/mcp/skill/tool transforms
                                └─ hook bridge    : V1 hooks + events ─────────────────────► ctx.*.hook / ctx.event.subscribe
```

## Install

1. Vendor the engine (not committed, so this repo stays bridge-only):

   ```sh
   scripts/vendor.sh 5.1.33
   ```

2. Point OpenCode V2 at this directory and remove the V1 entry:

   ```jsonc
   // ~/.config/opencode/opencode.json
   {
     "plugins": ["/absolute/path/to/oh-my-openagent-v2-bridge"]
   }
   ```

   Do not keep `"plugin": ["oh-my-opencode@latest"]` in the same file: the engine
   detects a second installation of itself and disables its own hooks.

3. The engine keeps its own configuration. OpenCode V2 reads it from
   `~/.omo/omo.jsonc` (the legacy `~/.config/opencode/oh-my-openagent.jsonc` is
   migrated there automatically, and the migration drops unrecognised keys — see
   `docs/omo-config.md`).

## What the bridge maps

| V1 extension point | V2 target | Status |
| --- | --- | --- |
| `tool` map | `ctx.tool.transform` + JSON Schema from the engine's own zod schemas | working |
| `tool.definition` | second `ctx.tool.transform` pass (`editor.update`) | working |
| `tool.execute.before` / `after` | `ctx.tool.hook("execute.before"/"execute.after")` | working |
| `config` | `ctx.agent/command/mcp/skill/tool` transforms, driven by the host's real providers/agents/default model | working |
| `event` | `ctx.event.subscribe` + V2→V1 event translation (session lifecycle, message content/deltas, tool calls, compaction, permissions) | working |
| `chat.message` | `ctx.session.hook("prompt")` | working |
| `chat.params` | `ctx.session.hook("context")` generation options | partial — model/variant switching has no V2 sink |
| `chat.headers` | `ctx.session.hook("model.request")` | working |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` → `event.system` | working |
| `experimental.chat.messages.transform` | `ctx.session.hook("context")` → `event.messages` | working |
| `experimental.session.compacting` | `ctx.session.hook("compaction")` | working |
| V1 `config.skills.urls` | fetch the engine's skill source → `ctx.skill.transform` | working |
| V1 `config.permission` allow rules | `ctx.permission.hook("evaluate")` | partial — `deny` rules are logged, not enforced |
| `experimental.compaction.autocontinue` | none | gap — logged |
| `client.tui.showToast` | none for server plugins | gap — logged |
| `client.interceptors.*`, `injectServerAuthIntoClient` | none | gap — logged, degrades to a warning |
| TUI sidebar (`dist/tui.js`) | V2 TUI plugin API | not ported |

`ctx.session.list` / `session.message` / `session.delete` / `config.get` have no
direct V2 counterpart on the plugin context, so the bridge maintains a
storage-backed session registry and reconstructs those V1 responses from it.

## Verified

`scripts/smoke.mjs` runs the whole bridge against a fake V2 context (no OpenCode
needed, `@opencode/plugin` stubbed by `scripts/alias-loader.mjs`):

```sh
node --import ./scripts/register-alias.mjs scripts/smoke.mjs
```

It asserts the engine boots, and that tools, agents, commands, MCP servers,
skills and hooks all register, then that cleanup runs.

Also verified against a live OpenCode **2.0.28** install: the engine loads, no
`failed to load plugin` entries, `ctx` tool catalog gains the engine's tools
(`task`, `call_omo_agent`, `background_output`, `lsp.*`, `look_at`, …), agents and
commands register, MCP servers connect, and the runtime security skills show up.

Diagnostics are appended to `~/.cache/oh-my-openagent-v2/bridge.log` (override the
directory with `OMO_V2_BRIDGE_LOG_DIR`).

## Repository layout

```
index.js                 plugin entry: Plugin.define + setup orchestration
lib/compat-client.js     V1 PluginInput/client facade over the V2 context
lib/tool-bridge.js       V1 tool definitions -> V2 tool registrations
lib/hook-bridge.js       V1 hooks + V2 events -> V2 hooks
lib/config-bridge.js     V1 config mutations -> V2 domain transforms
lib/message-text.js      V2 session messages -> V1 message views
lib/event-bus.js         single V2 subscription, fanned out to V1 consumers
lib/stores.js            session registry, todo store, status cache
scripts/vendor.sh        vendor the engine + zod into node_modules/
scripts/smoke.mjs        bridge smoke test without OpenCode
```

## Credits

The V1→V2 compatibility-layer architecture follows the approach and mapping
decisions of `Hallaxius/oh-my-openagent` PR #8768 (`feat(opencode-v2): full V2
runtime over V1 assembly`) — its `compat-client`, `hook-bridge`, `tool-bridge`,
`stores`, `message-text` and `event-bus` modules were the reference for this
bridge, adapted here to wrap the published bundle instead of the monorepo source
and to extend the event, permission, skill and tool-definition bridges.

The engine itself is [`code-yeongyu/oh-my-openagent`](https://github.com/code-yeongyu/oh-my-openagent)
(SUL-1.0) and is **not** vendored into this repository.

## License

Bridge code: MIT.
