/**
 * Subscription-only enforcement.
 *
 * This app intentionally does NOT support API-key billing. Every environment
 * variable that could route a run to pay-as-you-go API (or Bedrock/Vertex) is
 * stripped from the environment handed to the Claude Code subprocess, leaving
 * the logged-in `claude` CLI subscription as the only auth path.
 */

/** Env vars that would divert billing away from the Claude subscription. */
export const API_BILLING_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX'
] as const

/** Which of the API-billing vars are currently present in the environment. */
export function presentApiBillingVars(): string[] {
  return API_BILLING_ENV_VARS.filter((k) => Boolean(process.env[k]))
}

/**
 * A copy of process.env with all API-billing vectors removed. The SDK's `env`
 * option REPLACES the subprocess environment entirely, so we spread the rest of
 * process.env (PATH, HOME, …) and drop only the billing vars.
 */
export function subscriptionOnlyEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const key of API_BILLING_ENV_VARS) delete env[key]
  return env
}
