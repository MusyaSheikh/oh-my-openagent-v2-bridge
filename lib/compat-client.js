// V1 client compatibility layer.
//
// The omo engine was written against the V1 SDK client (`createOpencodeClient`),
// whose methods take `{ path, query, body }` and resolve to `{ data, error }`.
// V2 exposes flat domain methods on the plugin context that resolve to plain
// values. This module builds a V1-shaped client on top of the V2 context.
import { toV1MessageViews, toMillis } from "./message-text.js"
import { log } from "./logger.js"

// Justification: this encodes a non-obvious protocol invariant that already
// caused a runtime bug — the engine treats a present `error: null` as failure.
const ok = (data) => ({ data })
const fail = (error) => ({
  data: null,
  error: { message: error instanceof Error ? error.message : String(error) },
})

function readId(args) {
  const path = args && typeof args === "object" ? args.path : undefined
  if (path && typeof path === "object") {
    if (typeof path.id === "string") return path.id
    if (typeof path.sessionID === "string") return path.sessionID
  }
  if (args && typeof args === "object" && typeof args.sessionID === "string") return args.sessionID
  return undefined
}

function readBody(args) {
  if (args && typeof args === "object" && args.body && typeof args.body === "object") return args.body
  return {}
}

function readDirectory(args) {
  const query = args && typeof args === "object" ? args.query : undefined
  if (query && typeof query === "object" && typeof query.directory === "string") return query.directory
  const body = readBody(args)
  if (body.location && typeof body.location.directory === "string") return body.location.directory
  return undefined
}

function promptTextFromParts(parts) {
  if (!Array.isArray(parts)) return { text: "", files: [] }
  const texts = []
  const files = []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text" && typeof part.text === "string") texts.push(part.text)
    if (part.type === "file" && typeof part.url === "string") {
      files.push(typeof part.filename === "string" ? { uri: part.url, name: part.filename } : { uri: part.url })
    }
  }
  return { text: texts.join("\n"), files }
}

function modelRefFromV1(model) {
  if (!model || typeof model !== "object") return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : undefined
  const id = typeof model.modelID === "string" ? model.modelID : typeof model.id === "string" ? model.id : undefined
  if (!providerID || !id) return undefined
  return typeof model.variant === "string" ? { providerID, id, variant: model.variant } : { providerID, id }
}

/** Map a V2 SessionInfo into the V1 session shape the engine reads. */
function toV1SessionInfo(info, directory) {
  const time = info && typeof info.time === "object" ? info.time : {}
  return {
    id: info.id,
    parentID: info.parentID,
    projectID: info.projectID,
    directory,
    version: "",
    title: info.title ?? "",
    time: {
      created: toMillis(time.created),
      updated: toMillis(time.updated),
      ...(typeof time.idle === "number" ? { idle: toMillis(time.idle) } : {}),
    },
    ...(info.agent ? { agent: info.agent } : {}),
    ...(info.model ? { model: info.model } : {}),
    ...(info.metadata ? { metadata: info.metadata } : {}),
  }
}

function toV1ModelInfo(model) {
  return {
    ...model,
    id: model.id,
    providerID: model.providerID,
    provider: model.providerID,
    name: model.name ?? model.id,
  }
}

export function createV1CompatContext(ctx, deps) {
  const directory = (ctx.location && ctx.location.directory) || process.cwd()
  const registry = deps.registry
  const todos = deps.todos
  const statusCache = deps.statusCache
  const bunShell = deps.bunShell
  const serverUrl = deps.serverUrl

  const remember = async (info, targetDirectory) => {
    try {
      await registry.register({
        id: info.id,
        ...(info.parentID ? { parentID: info.parentID } : {}),
        directory: targetDirectory ?? directory,
        ...(info.agent ? { agent: info.agent } : {}),
        createdAt: toMillis(info.time && info.time.created) || Date.now(),
      })
    } catch (error) {
      log("[compat-client] registry register failed", { error: String(error) })
    }
  }

  const sessionGet = async (args) => {
    const id = readId(args)
    if (!id) return fail(new Error("session id is required"))
    try {
      const info = await ctx.session.get({ sessionID: id })
      const record = await registry.get(id)
      return ok(toV1SessionInfo(info, (record && record.directory) || readDirectory(args) || directory))
    } catch (error) {
      return fail(error)
    }
  }

  const sessionMessages = async (args) => {
    const id = readId(args)
    if (!id) return fail(new Error("session id is required"))
    try {
      const messages = await ctx.session.context({ sessionID: id })
      return ok(toV1MessageViews(messages, id))
    } catch (error) {
      return fail(error)
    }
  }

  const sessionCreate = async (args) => {
    const body = readBody(args)
    const targetDirectory = readDirectory(args) ?? directory
    try {
      const created = await ctx.session.create({
        ...(typeof body.id === "string" ? { id: body.id } : {}),
        ...(typeof body.parentID === "string" ? { parentID: body.parentID } : {}),
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.agent === "string" ? { agent: body.agent } : {}),
        ...(modelRefFromV1(body.model) ? { model: modelRefFromV1(body.model) } : {}),
        location: { directory: targetDirectory },
        ...(Array.isArray(body.permissions) ? { permissions: body.permissions } : {}),
      })
      await remember(created, targetDirectory)
      return ok(toV1SessionInfo(created, targetDirectory))
    } catch (error) {
      return fail(error)
    }
  }

  const sessionPromptAsync = async (args) => {
    const id = readId(args)
    if (!id) return fail(new Error("session id is required"))
    const body = readBody(args)
    try {
      if (typeof body.agent === "string" && body.agent) {
        await ctx.session.switchAgent({ sessionID: id, agent: body.agent }).catch((error) => {
          log("[compat-client] switchAgent failed", { agent: body.agent, error: String(error) })
        })
      }
      const model = modelRefFromV1(body.model)
      if (model) {
        await ctx.session.switchModel({ sessionID: id, model }).catch((error) => {
          log("[compat-client] switchModel failed", { model, error: String(error) })
        })
      }
      const fromParts = promptTextFromParts(body.parts)
      const text = typeof body.text === "string" && body.text.length > 0 ? body.text : fromParts.text
      const files = fromParts.files
      await ctx.session.prompt({
        sessionID: id,
        text,
        ...(files.length > 0 ? { files } : {}),
        delivery: "queue",
      })
      return ok(undefined)
    } catch (error) {
      return fail(error)
    }
  }

  const sessionSummaryFromContext = async (id) => {
    try {
      const messages = await ctx.session.context({ sessionID: id })
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]
        if (message && message.type === "compaction") {
          const summary =
            typeof message.summary === "string"
              ? message.summary
              : typeof message.text === "string"
                ? message.text
                : ""
          if (summary) return summary
        }
      }
    } catch {
      // best effort
    }
    return ""
  }

  const session = {
    get: sessionGet,
    messages: sessionMessages,
    status: async () => ok(statusCache.snapshot()),
    create: sessionCreate,
    update: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      const body = readBody(args)
      try {
        if (typeof body.title === "string") await ctx.session.update({ sessionID: id, title: body.title })
        return ok(undefined)
      } catch (error) {
        return fail(error)
      }
    },
    delete: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      try {
        await ctx.session.remove({ sessionID: id })
      } catch (error) {
        log("[compat-client] session.remove failed; dropping from registry only", { sessionID: id, error: String(error) })
      }
      await registry.remove(id)
      return ok(undefined)
    },
    abort: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      try {
        await ctx.session.interrupt({ sessionID: id, continue: false })
        return ok(undefined)
      } catch (error) {
        return fail(error)
      }
    },
    todo: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      return ok(await todos.get(id))
    },
    todoWrite: async (args) => {
      const id = readId(args)
      const body = readBody(args)
      if (!id) return fail(new Error("session id is required"))
      const list = Array.isArray(body.todos) ? body.todos : []
      await todos.set(id, list)
      return ok({ count: list.length })
    },
    children: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      return ok((await registry.childrenOf(id)).map((record) => toV1SessionInfo({ id: record.id, parentID: record.parentID }, record.directory)))
    },
    list: async () => {
      let live = []
      try {
        const response = await ctx.session.list()
        live = Array.isArray(response && response.data) ? response.data : []
      } catch (error) {
        log("[compat-client] session.list failed", { error: String(error) })
      }
      const known = await registry.list()
      for (const info of live) {
        const record = known.find((entry) => entry.id === info.id)
        await remember(info, record && record.directory)
      }
      const all = await registry.list()
      const byId = new Map(live.map((info) => [info.id, info]))
      return ok(
        all.map((record) => {
          const info = byId.get(record.id)
          return info
            ? toV1SessionInfo(info, record.directory)
            : { id: record.id, parentID: record.parentID, directory: record.directory, title: "" }
        }),
      )
    },
    message: async (args) => {
      const id = readId(args)
      const messageID =
        args && typeof args === "object" && args.path && typeof args.path.messageID === "string"
          ? args.path.messageID
          : undefined
      if (!id || !messageID) return fail(new Error("session id and message id are required"))
      try {
        const views = toV1MessageViews(await ctx.session.context({ sessionID: id }), id)
        const found = views.find((view) => view.info.id === messageID)
        if (!found) return fail(new Error(`message not found: ${messageID}`))
        return ok(found)
      } catch (error) {
        return fail(error)
      }
    },
    summarize: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      try {
        await ctx.session.compact({ sessionID: id })
      } catch (error) {
        log("[compat-client] session.compact failed", { sessionID: id, error: String(error) })
      }
      return ok({ summary: await sessionSummaryFromContext(id) })
    },
    prompt: async (args) => {
      const id = readId(args)
      if (!id) return fail(new Error("session id is required"))
      const result = await sessionPromptAsync(args)
      if (result.error) return result
      try {
        await ctx.session.wait({ sessionID: id })
        return ok(undefined)
      } catch (error) {
        return fail(error)
      }
    },
  }
  session.promptAsync = sessionPromptAsync
  session.rename = session.update

  const client = {
    session,
    tui: {
      showToast: async (args) => {
        const body = (args && typeof args === "object" && args.body) || {}
        log("[compat-client] tui.showToast (no V2 headless toast)", {
          title: body.title,
          message: body.message,
          variant: body.variant,
        })
        if (deps.onToast) {
          try {
            await deps.onToast(body)
          } catch (error) {
            log("[compat-client] toast bridge failed", { error: String(error) })
          }
        }
        return ok(undefined)
      },
    },
    config: {
      get: async () => {
        try {
          const entries = await ctx.config.get()
          return ok({ model: describeDefaultModel(entries) })
        } catch (error) {
          return ok({})
        }
      },
    },
    app: {
      agents: async () => {
        try {
          const response = await ctx.agent.list()
          return ok(Array.isArray(response && response.data) ? response.data : [])
        } catch (error) {
          return fail(error)
        }
      },
      skills: async (args) => {
        try {
          const response = await ctx.skill.list(args && typeof args === "object" && args.query ? { location: args.query } : undefined)
          return ok(Array.isArray(response && response.data) ? response.data : [])
        } catch (error) {
          return fail(error)
        }
      },
      log: async (args) => {
        const body = (args && typeof args === "object" && args.body) || {}
        log(`[omo] ${body.service ?? "app"}: ${body.message ?? ""}`, body.extra)
        return ok(undefined)
      },
    },
    provider: {
      list: async () => {
        try {
          const response = await ctx.provider.list()
          const providers = Array.isArray(response && response.data) ? response.data : []
          const all = providers.map((provider) => ({ id: provider.id, name: provider.name ?? provider.id }))
          const connected = providers
            .filter((provider) => provider.activation !== "disabled")
            .map((provider) => provider.id)
          return ok({ connected, all })
        } catch (error) {
          return fail(error)
        }
      },
    },
    model: {
      list: async () => {
        try {
          const response = await ctx.model.list()
          const models = Array.isArray(response && response.data) ? response.data : []
          return ok(models.map(toV1ModelInfo))
        } catch (error) {
          return fail(error)
        }
      },
      default: async () => {
        try {
          const response = await ctx.model.default()
          return ok(response && response.data ? toV1ModelInfo(response.data) : undefined)
        } catch (error) {
          return fail(error)
        }
      },
    },
    event: {
      subscribe: async (args) => {
        const wanted = readDirectory(args)
        async function* stream() {
          for await (const item of ctx.event.subscribe()) {
            if (!item || typeof item.type !== "string") continue
            if (wanted) {
              const location = item.location
              const itemDirectory = location && (location.directory || (location.data && location.data.directory))
              if (itemDirectory && itemDirectory !== wanted) continue
            }
            const properties = item.data ?? item.properties ?? {}
            yield { type: item.type, properties }
          }
        }
        return { stream: stream() }
      },
    },
    experimental: {
      session: {
        list: async (args) => {
          const listResult = await session.list()
          if (listResult.error) return listResult
          const query = (args && args.query) || {}
          const limit = typeof query.limit === "number" ? query.limit : undefined
          const items = listResult.data
          return ok(limit ? items.slice(0, limit) : items)
        },
      },
      workspace: { list: async () => ok([]) },
      tasks: {
        callToolStream: async () => fail(new Error("experimental.tasks is unavailable in the V2 bridge")),
      },
    },
    interceptors: {
      request: { use: () => () => {} },
      response: { use: () => () => {} },
      error: { use: () => () => {} },
    },
  }

  return {
    client,
    project: { id: ctx.location && ctx.location.project ? ctx.location.project.id : "unknown" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl,
    $: bunShell,
  }
}

function describeDefaultModel(entries) {
  if (!Array.isArray(entries)) return undefined
  for (const entry of entries) {
    if (entry && typeof entry === "object" && (entry.key === "model" || entry.id === "model")) {
      const value = entry.value
      if (typeof value === "string") return value
      if (value && typeof value === "object" && typeof value.providerID === "string") {
        return `${value.providerID}/${value.id ?? value.modelID}`
      }
    }
  }
  return undefined
}

export { toV1SessionInfo, toV1ModelInfo }
