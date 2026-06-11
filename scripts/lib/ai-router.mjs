const DEFAULT_TIMEOUT_MS = 30_000

function optionalEnv(name) {
  const value = process.env[name] ?? ''
  if (value.includes('example.com') || value.startsWith('your-')) return ''
  return value.trim()
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function normalizeProviderName(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function parseProviderList(value) {
  return String(value || '')
    .split(',')
    .map(normalizeProviderName)
    .filter(Boolean)
}

function providerFromPrefix(prefix) {
  const baseUrl = optionalEnv(`AI_${prefix}_BASE_URL`)
  const apiKey = optionalEnv(`AI_${prefix}_API_KEY`)
  const model = optionalEnv(`AI_${prefix}_MODEL`)
  if (!baseUrl || !apiKey || !model) return null

  return {
    name: prefix.toLowerCase(),
    baseUrl,
    apiKey,
    model,
    timeoutMs: Math.max(1000, Number(process.env[`AI_${prefix}_TIMEOUT_MS`] ?? process.env.AI_CHAT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)),
  }
}

export function readAiRouterConfig() {
  const configuredProviders = parseProviderList(process.env.AI_ROUTER_PROVIDERS)
    .map(providerFromPrefix)
    .filter(Boolean)

  const legacyProvider = {
    name: 'default',
    baseUrl: optionalEnv('AI_CHAT_BASE_URL'),
    apiKey: optionalEnv('AI_CHAT_API_KEY'),
    model: optionalEnv('AI_CHAT_MODEL'),
    timeoutMs: Math.max(1000, Number(process.env.AI_CHAT_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS)),
  }

  const providers = configuredProviders.length
    ? configuredProviders
    : legacyProvider.baseUrl && legacyProvider.apiKey && legacyProvider.model
      ? [legacyProvider]
      : []

  return { providers }
}

export function aiRouterConfigured(config) {
  return Boolean(config?.providers?.length)
}

export async function callAiRouter(config, request) {
  const errors = []

  for (const provider of config.providers) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), provider.timeoutMs)
    try {
      const res = await fetch(`${trimTrailingSlash(provider.baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...request,
          model: provider.model,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
      }

      const json = await res.json()
      const content = json?.choices?.[0]?.message?.content
      if (!content) throw new Error('Geen message.content terug.')

      return {
        provider: provider.name,
        model: provider.model,
        content,
        raw: json,
      }
    } catch (err) {
      errors.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error(`AI-router heeft geen werkende provider. ${errors.join(' | ')}`)
}
