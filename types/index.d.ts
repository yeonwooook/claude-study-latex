// The state this mod keeps for the session. `version` goes up each time a
// TikZ compile finishes, which redraws every message waiting on one.
export type CompileVersion = number

declare module 'claude-code' {
  interface PluginState {
    'study-latex': { version: CompileVersion }
  }
}
