import type { ModelInfo } from '../catalog'
import { hashText } from '../hash'
import { ruleFor } from '../modelRules'
import type { Conversation, Message, Prompt, ToolPart } from '../types'

export interface ToolDef {
  name: string
  description: string
  parameters: object
}

export interface AbilityCtx {
  conversationId: string
  messageId: string
  callId: string
  model: string
  key: string
  signal: AbortSignal
}

/** The words for one tool line: while running, when done, and the line a model reads after a flatten. */
export interface StepWords {
  running: string
  done: string
  past: string
}

export interface SendPlan {
  conversation: Conversation
  messages: Message[]
  startId: string | null
  trimmed: boolean
  cold: boolean
  key: string | null
}

export interface Ability {
  id: string
  title: string
  summary: string
  tools: ToolDef[]
  instructions?: string
  run(name: string, args: unknown, ctx: AbilityCtx): Promise<string>
  describe(part: ToolPart): StepWords
  hooks?: { beforeSend?(plan: SendPlan): Promise<void> }
  traits: { private?: true; untrusted?: true; outward?: true }
}

/** Fixed order. This order sets the order of the tools JSON. */
export let ABILITIES: Ability[] = []

/** Test seam: swap the list. Call with no argument to reset. */
export function setAbilitiesForTest(list: Ability[] = []): void {
  ABILITIES = list
}

/** A plain chat has none. Otherwise the chat's switches win, then the prompt's, then all on. */
export function enabledAbilities(c: Conversation, p: Prompt | null): Ability[] {
  if (c.plain) return []
  const switches = c.abilities ?? p?.abilities ?? null
  return ABILITIES.filter((a) => switches?.[a.id] !== false)
}

/** Null when the model has no tools, a model rule takes them away, or no tool is on. */
export function toolsFor(
  c: Conversation,
  p: Prompt | null,
  model: ModelInfo,
): { json: string; hash: string; tools: ToolDef[] } | null {
  if (!model.tools || ruleFor(model.id).noTools) return null
  // Key order is fixed here, so the same set always gives the same bytes.
  const tools: ToolDef[] = enabledAbilities(c, p).flatMap((a) =>
    a.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  )
  if (tools.length === 0) return null
  const json = JSON.stringify(tools)
  return { json, hash: hashText(json), tools }
}

/** The instruction text of the enabled abilities. Null when there is none or the model has no tools. */
export function abilityInstructions(enabled: Ability[], model: ModelInfo): string | null {
  if (!model.tools) return null
  const parts = enabled.map((a) => a.instructions?.trim()).filter((s): s is string => !!s)
  return parts.length ? parts.join('\n\n') : null
}

/** Never throws. Every problem comes back as text the model can read. */
export async function runTool(
  name: string,
  rawArgs: string,
  ctx: AbilityCtx,
  enabled: Ability[],
): Promise<string> {
  const ability = enabled.find((a) => a.tools.some((t) => t.name === name))
  if (!ability) {
    const names = enabled.flatMap((a) => a.tools.map((t) => t.name))
    return `Error: there is no tool called "${name}". ${
      names.length ? `The tools you have are: ${names.join(', ')}.` : 'You have no tools in this chat.'
    }`
  }
  let args: unknown
  try {
    args = rawArgs.trim() === '' ? {} : JSON.parse(rawArgs)
  } catch {
    return `Error: the arguments for "${name}" are not valid JSON. Send the call again with a valid JSON object.`
  }
  try {
    return await ability.run(name, args, ctx)
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return `Error: "${name}" failed. ${why}`
  }
}

/** Words for a tool line. Falls back to the tool name, so an old or removed tool still shows. */
export function describeStep(part: ToolPart): StepWords {
  const ability = ABILITIES.find((a) => a.tools.some((t) => t.name === part.name))
  if (ability) {
    try {
      return ability.describe(part)
    } catch {
      // Use the plain words below.
    }
  }
  return { running: `${part.name}…`, done: part.name, past: `(Used ${part.name}.)` }
}
