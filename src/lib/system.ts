import { storage } from './storage'
import type { Conversation, Prompt } from './types'

export const CAPABILITY_NOTE =
  'Formatting: you can use Markdown (headings, lists, tables, code, footnotes) and inline HTML with style attributes — for example a coloured span, a tinted box around a recipe card, or a different font family for a poem. Use it with restraint, only where it helps the reader.'

/** Prompt text + blank line + capability note. Either may be absent; nothing dynamic goes in. */
export function assembleSystem(promptText: string | null, capabilityNote: boolean): string | null {
  const parts: string[] = []
  if (promptText && promptText.trim() !== '') parts.push(promptText)
  if (capabilityNote) parts.push(CAPABILITY_NOTE)
  return parts.length ? parts.join('\n\n') : null
}

export async function systemFor(
  conversation: Conversation,
): Promise<{ system: string | null; prompt: Prompt | null }> {
  const ref = conversation.systemPromptRef
  const prompt = ref ? ((await storage.getPrompt(ref)) ?? null) : null
  return { system: assembleSystem(prompt?.text ?? null, conversation.capabilityNote), prompt }
}
