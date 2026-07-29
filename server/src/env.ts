import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Minimal repo-root .env loader (no dependency): KEY=VALUE lines, # comments.
// Real environment variables always win over file values.
const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env')

let fileVars: Record<string, string> | null = null

function loadFile(): Record<string, string> {
  if (fileVars) return fileVars
  fileVars = {}
  try {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      fileVars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  } catch {
    // No .env — fully keyless mode; defaults apply.
  }
  return fileVars
}

export function env(key: string, fallback: string): string {
  return process.env[key] ?? loadFile()[key] ?? fallback
}
