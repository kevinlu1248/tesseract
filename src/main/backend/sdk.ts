/**
 * The Agent SDK ships ESM-only (`sdk.mjs`). The main process is bundled as
 * CommonJS, so we must load the SDK with a genuine runtime dynamic import().
 *
 * `new Function('return import(s)')` hides the import from esbuild, which would
 * otherwise rewrite `import()` into a `require()` helper and crash on the
 * ESM-only package. The SDK is externalized in electron.vite.config.ts so it is
 * resolved from node_modules at runtime, never bundled.
 */
import type * as ClaudeAgentSdk from '@anthropic-ai/claude-agent-sdk'

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  s: string
) => Promise<typeof ClaudeAgentSdk>

let cached: typeof ClaudeAgentSdk | null = null

export async function loadSdk(): Promise<typeof ClaudeAgentSdk> {
  if (!cached) cached = await dynamicImport('@anthropic-ai/claude-agent-sdk')
  return cached
}

export type Sdk = typeof ClaudeAgentSdk
