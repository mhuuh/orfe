import { fetchModels, type RawModel } from './openrouter'
import { storage } from './storage'

export interface ModelInfo {
  id: string
  name: string
  created: number
  contextLength: number
  priceIn: number
  priceOut: number
  inputModalities: string[]
  outputModalities: string[]
  efforts: string[] | null
  defaultEffort: string | null
  free: boolean
}

const CACHE_KEY = 'catalog'
const MAX_AGE = 60 * 60 * 1000
const NON_CHAT = new Set(['embeddings', 'rerank', 'decisions', 'transcription'])

// Per-token price string -> USD per 1M tokens. Missing, negative ("-1" on routers)
// or non-finite values count as 0.
function perMillion(s: string | undefined): number {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n * 1_000_000 : 0
}

export function toModelInfo(raw: RawModel): ModelInfo {
  const priceIn = perMillion(raw.pricing?.prompt)
  const priceOut = perMillion(raw.pricing?.completion)
  const efforts = raw.reasoning?.supported_efforts
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    created: raw.created ?? 0,
    contextLength: raw.context_length ?? 0,
    priceIn,
    priceOut,
    inputModalities: raw.architecture?.input_modalities ?? ['text'],
    outputModalities: raw.architecture?.output_modalities ?? ['text'],
    efforts: efforts && efforts.length > 0 ? efforts : null,
    defaultEffort: raw.reasoning?.default_effort ?? null,
    free: (priceIn === 0 && priceOut === 0) || raw.id.endsWith(':free'),
  }
}

export function chatModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => {
    const out = m.outputModalities
    return out.length === 0 || !out.every((o) => NON_CHAT.has(o))
  })
}

export const sortNewest = (models: ModelInfo[]): ModelInfo[] =>
  [...models].sort((a, b) => b.created - a.created || a.name.localeCompare(b.name))

export const sortAZ = (models: ModelInfo[]): ModelInfo[] =>
  [...models].sort((a, b) => a.name.localeCompare(b.name))

export function groupByMonth(
  models: ModelInfo[],
  locale = 'en-GB',
): { label: string; models: ModelInfo[] }[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const groups: { label: string; models: ModelInfo[] }[] = []
  for (const m of sortNewest(models)) {
    const label = fmt.format(new Date(m.created * 1000))
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.models.push(m)
    else groups.push({ label, models: [m] })
  }
  return groups
}

export function search(models: ModelInfo[], q: string): ModelInfo[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return models
  return models.filter((m) => {
    const hay = `${m.id} ${m.name}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

export async function loadCatalog(
  opts: { force?: boolean } = {},
): Promise<{ models: ModelInfo[]; fetchedAt: number; stale: boolean; error?: string }> {
  const cached = await storage.getCache<ModelInfo[]>(CACHE_KEY)
  const age = cached ? Date.now() - cached.at : Infinity
  if (cached && age <= MAX_AGE && !opts.force) {
    return { models: cached.value, fetchedAt: cached.at, stale: false }
  }
  try {
    const models = (await fetchModels()).map(toModelInfo)
    await storage.setCache(CACHE_KEY, models)
    return { models, fetchedAt: Date.now(), stale: false }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (cached) return { models: cached.value, fetchedAt: cached.at, stale: age > MAX_AGE, error }
    return { models: [], fetchedAt: 0, stale: true, error }
  }
}
