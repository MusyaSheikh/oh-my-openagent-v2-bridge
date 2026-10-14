// Probe: call the V1 oh-my-openagent server entry with a synthetic PluginInput
// and inspect what it returns (hook keys, tool count, tool arg schema shape).
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const mod = await import("oh-my-opencode")
const pluginModule = mod.default
console.log("module keys:", Object.keys(mod))
console.log("module.id:", pluginModule?.id, "has server:", typeof pluginModule?.server)

const directory = mkdtempSync(join(tmpdir(), "omo-probe-"))
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

let hooks
try {
  hooks = await pluginModule.server(input, {})
} catch (error) {
  console.log("server() threw:", error?.message)
  console.log(error?.stack?.split("\n").slice(0, 12).join("\n"))
  process.exit(1)
}

console.log("hook keys:", Object.keys(hooks))
const tools = hooks.tool ?? {}
console.log("tool count:", Object.keys(tools).length)
console.log("tool names:", Object.keys(tools).slice(0, 60).join(", "))

const firstName = Object.keys(tools)[0]
if (firstName) {
  const def = tools[firstName]
  console.log("--- sample tool:", firstName)
  const argNames = Object.keys(def.args ?? {})
  console.log("args:", argNames.join(", "))
  for (const name of argNames.slice(0, 3)) {
    const s = def.args[name]
    console.log(`  arg[${name}] optin=${s?._zod?.optin} hasOverride=${typeof s?._zod?.toJSONSchema}`)
    try {
      const js = s?._zod?.toJSONSchema?.()
      console.log(`    override json: ${JSON.stringify(js)?.slice(0, 400)}`)
    } catch (error) {
      console.log(`    override threw: ${error.message}`)
    }
  }
  try {
    const z = (await import("zod")).z
    const js = z.toJSONSchema(z.object(def.args), { io: "input" })
    console.log("z.object json (first 600):", JSON.stringify(js).slice(0, 600))
  } catch (error) {
    console.log("z.object toJSONSchema failed:", error.message)
  }
}

if (typeof hooks.dispose === "function") {
  try {
    await hooks.dispose()
  } catch (error) {
    console.log("dispose error:", error?.message)
  }
}
process.exit(0)
