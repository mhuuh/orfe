import type { ModelInfo } from '../catalog'
import { hashText } from '../hash'
import { ruleFor } from '../modelRules'
import type { Conversation, Message, Prompt, ToolPart } from '../types'
import { notesAbility } from './notes'
import { outcome } from './outcome'

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
  /** The tools that change a note. */
  writes?: string[]
}

/** Fixed order. This order sets the order of the tools JSON. */
const SHIPPED: Ability[] = [notesAbility]

export let ABILITIES: Ability[] = SHIPPED

/** Test seam: swap the list. Call with no argument to reset. */
export function setAbilitiesForTest(list: Ability[] = SHIPPED): void {
  ABILITIES = list
}

/** One switch as it reads now: the chat's set wins, then the prompt's, then on. Plain leaves it alone. */
export const abilityOn = (c: Conversation, p: Prompt | null, id: string): boolean => (c.abilities ?? p?.abilities)?.[id] !== false

/** A plain chat has none. Otherwise the ones with their switch on. */
export function enabledAbilities(c: Conversation, p: Prompt | null): Ability[] {
  if (c.plain) return []
  return ABILITIES.filter((a) => abilityOn(c, p, a.id))
}

/** A model can list tools and a model rule can still take them away. */
export const takesTools = (model: ModelInfo): boolean => model.tools && !ruleFor(model.id).noTools

/** Null when the model takes no tools or no tool is on. */
export function toolsFor(
  c: Conversation,
  p: Prompt | null,
  model: ModelInfo,
): { json: string; hash: string; tools: ToolDef[] } | null {
  if (!takesTools(model)) return null
  // Key order is fixed here, so the same set always gives the same bytes.
  const tools: ToolDef[] = enabledAbilities(c, p).flatMap((a) =>
    a.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  )
  if (tools.length === 0) return null
  const json = JSON.stringify(tools)
  return { json, hash: hashText(json), tools }
}

/** What this model can really use. A model without tools has no abilities. */
export const activeAbilities = (c: Conversation, p: Prompt | null, model: ModelInfo): Ability[] =>
  toolsFor(c, p, model) ? enabledAbilities(c, p) : []

/** Whether the system message carries the note index. */
export const wantsIndex = (enabled: Ability[]): boolean => enabled.some((a) => a.id === notesAbility.id)

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

const abilityOf = (toolName: string): Ability | undefined => ABILITIES.find((a) => a.tools.some((t) => t.name === toolName))

/** Whether this tool changes a note. */
export const writesNotes = (toolName: string): boolean => abilityOf(toolName)?.writes?.includes(toolName) === true

/**
 * The trust gate (spec §13). After an `untrusted` result in this reply, a note write or an `outward`
 * tool waits for a visible OK. A stopped call gave the model nothing, and an open one nothing yet.
 * Nothing that ships is `untrusted`, so today nothing waits.
 */
export function needsOk(toolName: string, reply: ToolPart[]): boolean {
  if (!writesNotes(toolName) && !abilityOf(toolName)?.traits.outward) return false
  return reply.some((p) => (p.status === 'done' || p.status === 'error') && abilityOf(p.name)?.traits.untrusted)
}

/** Words for a tool line. Falls back to the tool name, so an old or removed tool still shows. */
export function describeStep(part: ToolPart): StepWords {
  const ability = abilityOf(part.name)
  if (ability) {
    try {
      return ability.describe(part)
    } catch {
      // Use the plain words below.
    }
  }
  const { name } = part
  const running = `${name}…`
  switch (outcome(part)) {
    case 'done':
      return { running, done: name, past: `(Used ${name}.)` }
    case 'failed':
      return { running, done: `${name} failed`, past: `(Tried ${name}. It failed.)` }
    case 'stopped':
      return { running, done: `${name} stopped`, past: `(Stopped ${name} before it finished.)` }
    case 'unknown':
      return { running, done: `${name} not finished`, past: `(Started ${name}. It may or may not have happened.)` }
  }
}
