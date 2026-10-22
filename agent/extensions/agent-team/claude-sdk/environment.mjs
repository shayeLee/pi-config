/** A child never silently inherits the Pi host's API billing or routing configuration. */
export function subscriptionEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(ANTHROPIC_|CLAUDE_CODE_(USE_|SKIP_.*AUTH|OAUTH_|API_KEY|PROVIDER_MANAGED)|CLAUDECODE$|MODEL_FAILBACK_|PI_USAGE_ROOT_SESSION_ID$)/.test(key)));
}

