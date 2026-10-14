// Probe 2: capture what the V1 `config` hook mutates, so the bridge can replay
// it as V2 domain transforms (agents / commands / mcp / skills / permission / tools).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const mod = await import("oh-my-opencode")
const pluginModule = mod.default
const directory = mkdtempSync(join(tmpdir(), "omo-probe2-"))
const ok = (data) => Promise.resolve({ data, error: null })

const client = {
  session: {
    messages: () => ok([]),
    get: () => ok({ id: "ses_probe", title: "probe", time: { created: Date.now(), updated: Date.now() } }),
    status: () => ok({}),
    list: () => ok([]),
    create: () => ok({ id: "ses_probe" }),
    todo: () => ok([]),
    abort: () => ok(undefined),
  },
  app: { agents: () => ok([]), skills: () => ok([]), log: () => ok(undefined) },
  config: { get: () => ok({}) },
  model: { list: () => ok([]) },
  provider: { list: () => ok({ connected: [], all: [] }) },
  tui: { showToast: () => ok(undefined) },
  event: { subscribe: async () => ({ stream: (async function* () {})() }) },
}

const input = {
  client,
  project: { id: "probe" },
  directory,
  worktree: directory,
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://127.0.0.1:1"),
  $: undefined,
}

const hooks = await pluginModule.server(input, {})
console.log("config hook type:", typeof hooks.config)
if (typeof hooks.config === "function") {
  const config = { $schema: "", agent: {}, command: {}, mcp: {}, skills: {}, tools: {}, permission: {} }
  try {
    await hooks.config(config)
  } catch (error) {
    console.log("config hook threw:", error.message)
  }
  const shape = (value) => {
    if (Array.isArray(value)) return `array(${value.length})`
    if (value && typeof value === "object") return `object{${Object.keys(value).slice(0, 40).join(",")}}`
    return typeof value
  }
  console.log("default_agent:", config.default_agent)
  console.log("agent:", shape(config.agent))
  console.log("command:", shape(config.command))
  console.log("mcp:", shape(config.mcp))
  console.log("skills:", JSON.stringify(config.skills)?.slice(0, 300))
  console.log("tools:", JSON.stringify(config.tools)?.slice(0, 400))
  console.log("permission:", JSON.stringify(config.permission)?.slice(0, 400))
  console.log("formatter:", shape(config.formatter))
  const agentKeys = Object.keys(config.agent ?? {})
  console.log("agent keys:", agentKeys.join(", "))
  const first = agentKeys[0]
  if (first) {
    const a = config.agent[first]
    console.log(`sample agent[${first}] fields:`, Object.keys(a).join(", "))
    console.log(`  mode=${a.mode} model=${JSON.stringify(a.model)} hidden=${a.hidden} color=${a.color}`)
    console.log(`  description: ${String(a.description).slice(0, 120)}`)
    console.log(`  prompt length: ${String(a.prompt ?? "").length}`)
    console.log(`  permission: ${JSON.stringify(a.permission)?.slice(0, 200)}`)
  }
  const cmdKeys = Object.keys(config.command ?? {})
  console.log("command keys:", cmdKeys.slice(0, 30).join(", "))
  if (cmdKeys[0]) {
    console.log("sample command:", JSON.stringify(config.command[cmdKeys[0]])?.slice(0, 300))
  }
  const mcpKeys = Object.keys(config.mcp ?? {})
  console.log("mcp keys:", mcpKeys.join(", "))
  if (mcpKeys[0]) console.log("sample mcp:", JSON.stringify(config.mcp[mcpKeys[0]])?.slice(0, 400))
}
if (typeof hooks.dispose === "function") {
  try {
    await hooks.dispose()
  } catch {}
}
process.exit(0)
