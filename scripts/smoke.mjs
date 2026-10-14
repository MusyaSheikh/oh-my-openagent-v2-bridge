// End-to-end smoke test of the bridge against a fake V2 plugin context.
//
// Run: node --import ./scripts/register-alias.mjs scripts/smoke.mjs
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = mkdtempSync(join(tmpdir(), "omo-v2-smoke-"))

function makeEditors() {
  const tools = new Map()
  const agents = new Map()
  const commands = new Map()
  const mcp = new Map()
  const skills = new Map()
  const registered = { toolHooks: [], sessionHooks: [], shellHooks: [], transforms: [] }

  const transform = (kind, store) => async (callback) => {
    const editor = {
      list: () => (kind === "mcp" ? [...store.entries()] : [...store.values()]),
      get: (id) => (kind === "mcp" ? store.get(id) : store.get(id)),
      add: (value) => store.set(value.name ?? value.id, value),
      update: (id, update) => {
        const current = store.get(id)
        if (!current) {
          if (kind === "agent") {
            const created = { id, name: id, mode: "all", hidden: false, permissions: [], request: { settings: {}, headers: {}, body: {} } }
            update(created)
            store.set(id, created)
          }
          return
        }
        update(current)
      },
      remove: (id) => store.delete(id),
      set: (id, value) => store.set(id, value),
      default: (id) => {
        store.set("__default__", id)
      },
      namespace: () => {},
    }
    callback(editor)
    registered.transforms.push(kind)
    return { dispose: async () => {} }
  }

  return { tools, agents, commands, mcp, skills, registered, transform }
}

const stores = makeEditors()
const memory = new Map()

const ctx = {
  app: { name: "opencode", version: "2.0.28", channel: "stable" },
  location: { directory, project: { id: "proj_smoke", directory, canonical: directory } },
  options: {},
  storage: {
    async get(key) {
      return memory.get(key)
    },
    async set(key, value) {
      memory.set(key, value)
    },
    async remove(key) {
      memory.delete(key)
    },
    async scan({ prefix, limit }) {
      const entries = [...memory.entries()].filter(([key]) => key.startsWith(prefix))
      return { entries: entries.slice(0, limit ?? 100).map(([key, value]) => ({ key, value })) }
    },
  },
  tool: {
    async list() {
      return [...stores.tools.values()]
    },
    transform: stores.transform("tool", stores.tools),
    async reload() {},
    async hook(name, callback) {
      stores.registered.toolHooks.push(name)
      return { dispose: async () => {} }
    },
  },
  agent: {
    async list() {
      return { location: {}, data: [...stores.agents.values()] }
    },
    async get({ agentID }) {
      return { location: {}, data: stores.agents.get(agentID) }
    },
    transform: stores.transform("agent", stores.agents),
    async reload() {},
  },
  command: {
    async list() {
      return { location: {}, data: [...stores.commands.values()] }
    },
    transform: stores.transform("command", stores.commands),
    async reload() {},
  },
  mcp: {
    async list() {
      return { data: [...stores.mcp.entries()] }
    },
    transform: stores.transform("mcp", stores.mcp),
    async reload() {},
  },
  skill: {
    async list() {
      return { location: {}, data: [...stores.skills.values()] }
    },
    transform: stores.transform("skill", stores.skills),
    async reload() {},
  },
  session: {
    async get({ sessionID }) {
      return { id: sessionID, title: "smoke", projectID: "proj_smoke", cost: 0, tokens: {}, time: { created: Date.now(), updated: Date.now() }, location: {} }
    },
    async context() {
      return []
    },
    async list() {
      return { data: [], cursor: {} }
    },
    async create(input) {
      return { id: "ses_smoke", title: input?.title ?? "", projectID: "proj_smoke", cost: 0, tokens: {}, time: { created: Date.now(), updated: Date.now() }, location: {} }
    },
    async update() {},
    async remove() {},
    async interrupt() {},
    async prompt() {
      return { id: "msg_smoke" }
    },
    async wait() {},
    async compact() {
      return { id: "msg_compact" }
    },
    async generate() {
      return { text: "summary" }
    },
    async switchAgent() {},
    async switchModel() {},
    async hook(name, callback) {
      stores.registered.sessionHooks.push(name)
      return { dispose: async () => {} }
    },
  },
  event: {
    async *subscribe() {
      yield { type: "session.idle", data: { sessionID: "ses_smoke" } }
      yield { type: "session.created", data: { sessionID: "ses_smoke", slug: "smoke", version: "2.0.28" } }
      yield { type: "session.text.delta", data: { sessionID: "ses_smoke", assistantMessageID: "msg_1", ordinal: 0, delta: "hi" } }
      yield { type: "session.message.content.updated", data: { sessionID: "ses_smoke", messageID: "msg_1", content: [{ type: "text", text: "hi" }] } }
      yield { type: "session.compaction.ended", data: { sessionID: "ses_smoke" } }
      yield { type: "session.execution.failed", data: { sessionID: "ses_smoke", error: { type: "x", message: "boom" } } }
    },
  },
  provider: {
    async list() {
      return { location: {}, data: [{ id: "opencode-go", name: "OpenCode Go", activation: "enabled" }] }
    },
  },
  model: {
    async list() {
      return { location: {}, data: [{ id: "deepseek-v4.1-flash", providerID: "opencode-go", name: "DeepSeek" }] }
    },
    async default() {
      return { location: {}, data: { id: "deepseek-v4.1-flash", providerID: "opencode-go" } }
    },
  },
  config: {
    async get() {
      return [{ key: "model", value: "opencode-go/deepseek-v4.1-flash" }]
    },
  },
  permission: {
    async hook(name, callback) {
      stores.registered.sessionHooks.push(`permission.hook:${name}`)
      return { dispose: async () => {} }
    },
  },
  rpc: { register: async () => ({ events: { emit: async () => {} }, dispose: async () => {} }) },
  generate: {},
  plugin: {},
  reference: {},
  integration: {},
  credential: {},
  experimental: {},
  vcs: {},
  websearch: {},
  worktree: {},
}

const module = await import("../index.js")
const plugin = module.default
console.log("plugin id:", plugin.id)

const cleanup = await plugin.setup(ctx)

console.log("--- registrations")
console.log("tools:", stores.tools.size)
console.log("  sample tool input schema:", JSON.stringify([...stores.tools.values()][0]?.input)?.slice(0, 240))
console.log("agents:", stores.agents.size)
console.log("agents default:", stores.agents.get("__default__"))
const agentSample = [...stores.agents.entries()].find(([id]) => id !== "__default__")
console.log(`  sample agent [${agentSample?.[0]}]:`, JSON.stringify({ name: agentSample?.[1].name, mode: agentSample?.[1].mode, model: agentSample?.[1].model, hidden: agentSample?.[1].hidden, system: typeof agentSample?.[1].system === "string" ? `len=${agentSample[1].system.length}` : undefined, permissions: agentSample?.[1].permissions?.length }))
console.log("commands:", stores.commands.size)
console.log("mcp:", stores.mcp.size, [...stores.mcp.entries()].map(([name, cfg]) => `${name}:${cfg.type}`).join(", "))
console.log("tool hooks:", stores.registered.toolHooks)
console.log("session hooks:", stores.registered.sessionHooks)

await cleanup()
console.log("cleanup ok")
process.exit(0)
