import { resolve as Resolve } from 'node:path'
import { RunCommand } from './Command'

// Windows PowerShell may decode native output with a legacy code page.
// JSON escapes keep the transport ASCII while preserving every Unicode value.
function Json(Value: unknown): string {
  return JSON.stringify(Value, null, 2).replace(/[^\x00-\x7f]/g, (Character) => `\\u${Character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

void RunCommand(process.argv.slice(2), Resolve(__dirname, '../../../..')).then((Result) => {
  process.stdout.write(`${Json(Result)}\n`)
  if (!Result.ok) process.exitCode = 1
}).catch((CaughtError: unknown) => {
  process.stderr.write(`${Json({ ok: false, error: CaughtError instanceof Error ? CaughtError.message : String(CaughtError) })}\n`)
  process.exitCode = 1
})
