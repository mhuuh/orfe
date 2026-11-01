import { abilityInstructions, activeAbilities, wantsIndex } from './abilities/registry'
import type { ModelInfo } from './catalog'
import { storage } from './storage'
import type { Conversation, Prompt } from './types'

export const CAPABILITY_NOTE =
  'Formatting: you can use Markdown (headings, lists, tables, code, footnotes) and inline HTML with style attributes — for example a coloured span, a tinted box around a recipe card, or a different font family for a poem. Use it with restraint, only where it helps the reader.'

/**
 * Prompt text, capability note, then the extras, with a blank line between. Any may be absent.
 * The extras, in order: ability instructions, note index, summary block.
 * The index and the summary block change only at a cold moment or a trim. An undo moves the index too.
 */
export function assembleSystem(
  promptText: string | null,
  capabilityNote: boolean,
  extras: (string | null)[] = [],
): string | null {
  const parts: string[] = []
  if (promptText && promptText.trim() !== '') parts.push(promptText)
  if (capabilityNote) parts.push(CAPABILITY_NOTE)
  for (const extra of extras) if (extra && extra.trim() !== '') parts.push(extra)
  return parts.length ? parts.join('\n\n') : null
}

/**
 * The system text for this chat and model, with `index` as the note index. A chat with no tools
 * for this model, or with notes off, gets no instructions or no index. A plain chat gets its prompt
 * and nothing else.
 */
export function systemText(c: Conversation, prompt: Prompt | null, model: ModelInfo, index: string | null): string | null {
  if (c.plain) return assembleSystem(prompt?.text ?? null, false)
  const enabled = activeAbilities(c, prompt, model)
  const extras = [abilityInstructions(enabled, model), wantsIndex(enabled) ? index : null]
  return assembleSystem(prompt?.text ?? null, c.capabilityNote, extras)
}

/** The stored state as a send would use it, before any refresh. The header counts this too. */
export async function systemFor(
  conversation: Conversation,
  model: ModelInfo,
): Promise<{ system: string | null; prompt: Prompt | null }> {
  const ref = conversation.systemPromptRef
  const prompt = ref ? ((await storage.getPrompt(ref)) ?? null) : null
  return { system: systemText(conversation, prompt, model, conversation.notesIndex), prompt }
}
