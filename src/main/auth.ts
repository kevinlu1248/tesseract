import type { AuthInfo } from '../shared/ipc'
import { presentApiBillingVars } from './subscriptionAuth'

/**
 * This app runs subscription-only. We never use API-key billing: any
 * API-billing env vars are stripped from the Claude Code subprocess (see
 * subscriptionAuth.ts), so the only auth path is the logged-in `claude` CLI
 * subscription. Auth status here is informational — if billing vars are present
 * in the environment we report that they are being ignored, not used.
 */
export function detectAuth(): AuthInfo {
  const ignored = presentApiBillingVars()
  if (ignored.length > 0) {
    return {
      mode: 'subscription',
      apiKeyEnvSet: true,
      detail: `Subscription-only mode. Ignoring ${ignored.join(', ')} in the environment — this app never bills API rates.`
    }
  }
  return {
    mode: 'subscription',
    apiKeyEnvSet: false,
    detail: 'Subscription-only mode. Using your logged-in Claude subscription.'
  }
}
