// Stub of the V2 runtime module `@opencode/plugin` for local smoke tests.
export const Plugin = {
  define: (definition) => definition,
}
export const Model = { ID: { make: (value) => value }, Info: { default: () => ({}) } }
export const Provider = { ID: { make: (value) => value }, Info: { empty: () => ({}) } }
export const Agent = {}
export const Command = {}
export const Connection = {}
export const Credential = {}
export const Integration = {}
export const Location = {}
export const Mcp = {}
export const PersistentPty = {}
export const Reference = {}
export const Rpc = {}
export const Skill = {}
export const Vcs = {}
export const WebSearch = {}
export const Worktree = {}

// Stub of `@opencode/client/service` used by the serverUrl discovery.
export const Service = {
  discover: async () => ({ url: "http://127.0.0.1:4096" }),
}
