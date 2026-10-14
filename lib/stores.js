// Storage-backed stores that give the V1 engine the state V2 keeps internally:
// a session registry (V1 session.list/children/delete), todo store
// (V1 session.todo) and an in-memory status cache (V1 session.status).
const SESSION_PREFIX = "omo-v2:session:"
const TODO_PREFIX = "omo-v2:todos:"

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asSessionRecord(value) {
  if (!isRecord(value)) return undefined
  const { id, directory } = value
  if (typeof id !== "string" || typeof directory !== "string") return undefined
  const record = { id, directory, createdAt: 0 }
  if (typeof value.parentID === "string") record.parentID = value.parentID
  if (typeof value.agent === "string") record.agent = value.agent
  if (typeof value.createdAt === "number") record.createdAt = value.createdAt
  return record
}

function asTodoList(value) {
  if (!Array.isArray(value)) return undefined
  const items = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.content !== "string") return undefined
    const status = entry.status
    if (status !== "pending" && status !== "in_progress" && status !== "completed" && status !== "cancelled") {
      return undefined
    }
    const item = { content: entry.content, status }
    if (typeof entry.id === "string") item.id = entry.id
    if (typeof entry.priority === "string") item.priority = entry.priority
    items.push(item)
  }
  return items
}

export function createSessionRegistry(storage) {
  const registry = {
    async register(record) {
      await storage.set(`${SESSION_PREFIX}${record.id}`, { ...record })
    },
    async get(sessionID) {
      return asSessionRecord(await storage.get(`${SESSION_PREFIX}${sessionID}`))
    },
    async childrenOf(parentID) {
      return (await registry.list()).filter((record) => record.parentID === parentID)
    },
    async list() {
      const records = []
      let after
      for (;;) {
        const page = await storage.scan({ prefix: SESSION_PREFIX, after, limit: 100 })
        for (const entry of page.entries) {
          const record = asSessionRecord(entry.value)
          if (record) records.push(record)
        }
        if (!page.next) break
        after = page.next
      }
      return records.sort((a, b) => a.createdAt - b.createdAt)
    },
    async remove(sessionID) {
      await storage.remove(`${SESSION_PREFIX}${sessionID}`)
    },
  }
  return registry
}

export function createTodoStore(storage) {
  return {
    async get(sessionID) {
      return asTodoList(await storage.get(`${TODO_PREFIX}${sessionID}`)) ?? []
    },
    async set(sessionID, todos) {
      await storage.set(`${TODO_PREFIX}${sessionID}`, [...todos])
    },
  }
}

export function createStatusCache() {
  const statuses = new Map()
  return {
    get(sessionID) {
      return statuses.get(sessionID) ?? "idle"
    },
    set(sessionID, status) {
      statuses.set(sessionID, status)
    },
    snapshot() {
      const result = {}
      for (const [id, status] of statuses) result[id] = { type: status }
      return result
    },
  }
}
