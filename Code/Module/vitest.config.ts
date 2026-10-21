import { defineConfig as DefineConfig } from 'vitest/config'
export default DefineConfig({ test: {
  include: ['Source/**/*Test.ts', 'Source/**/*Test.tsx', 'Scripts/**/*Test.ts'],
  reporters: ['default', 'json'],
  outputFile: { json: 'Runtime/Tests/Reports/Unit.json' },
} })
