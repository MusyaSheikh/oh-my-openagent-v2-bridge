// Single V2 event subscription, fanned out to every V1 consumer.
function readSessionID(event) {
  const data = event && event.data
  if (typeof data !== "object" || data === null) return undefined
  const sessionID = data.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function statusFromType(type) {
  if (type === "session.status") return undefined
  if (type === "session.idle") return "idle"
  if (type === "session.execution.started") return "busy"
  if (
    type === "session.execution.succeeded" ||
    type === "session.execution.failed" ||
    type === "session.execution.interrupted"
  ) {
    return "idle"
  }
  return undefined
}

export function createEventBus(event, statusCache) {
  const handlers = new Map()
  return {
    on(type, handler) {
      let set = handlers.get(type)
      if (!set) {
        set = new Set()
        handlers.set(type, set)
      }
      set.add(handler)
      return () => {
        set.delete(handler)
      }
    },
    async run(signal) {
      const stream = event.subscribe({ signal })
      for await (const item of stream) {
        if (signal.aborted) break
        const type = item && item.type
        if (typeof type !== "string") continue
        if (type === "session.status") {
          const data = item.data
          const sessionID = data && typeof data.sessionID === "string" ? data.sessionID : undefined
          const status = data && data.status ? data.status.type : undefined
          if (sessionID && (status === "idle" || status === "busy" || status === "retry")) {
            statusCache.set(sessionID, status)
          }
        } else {
          const derived = statusFromType(type)
          const sessionID = readSessionID(item)
          if (derived && sessionID) statusCache.set(sessionID, derived)
        }
        const set = handlers.get(type)
        if (!set) continue
        for (const handler of [...set]) {
          try {
            await handler(item)
          } catch {
            // A failing consumer must not kill the shared stream.
          }
        }
      }
    },
  }
}
