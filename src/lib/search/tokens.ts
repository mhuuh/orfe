import { stemmer as finnishStem } from '@orama/stemmers/finnish'
import { stem as englishStem } from 'porter2'

const WORD = /[\p{L}\p{N}]+/gu
/** Longer than any real word, Finnish compounds too. A pasted blob must not fill the index. */
const MAX_WORD = 64
/**
 * Tokens kept per message. Past this the rest of the message is not indexed. At 2,000 a 500 KB
 * message takes about 160 ms under a 6x throttle, and about 12 KB of varied text still fits whole.
 */
export const MAX_TOKENS = 2000

/** Lower-cased words in reading order. NFC first: a phone keyboard can send ä as two code points. */
export function wordsOf(text: string): string[] {
  const words = text.normalize('NFC').toLowerCase().match(WORD) ?? []
  return words.filter((w) => w.length <= MAX_WORD)
}

/** One word as the index holds it: raw, Finnish stem, English stem. The language of a word is not known, so both stems go in. */
export const wordTokens = (word: string): string[] => [...new Set([word, finnishStem(word), englishStem(word)])].filter((t) => t !== '')

/**
 * Raw words plus Finnish and English Snowball stems, deduped and lower-cased. `ä` and `ö` stay:
 * folding merges different words. A repeated word is stemmed once. A very long message costs a
 * long tokenise and a long write, with `messages` held, so it stops at `MAX_TOKENS`.
 */
export function tokens(text: string): string[] {
  const seen = new Set<string>()
  const found = new Set<string>()
  for (const [word] of text.normalize('NFC').toLowerCase().matchAll(WORD)) {
    if (word.length > MAX_WORD || seen.has(word)) continue
    seen.add(word)
    for (const token of wordTokens(word)) found.add(token)
    if (found.size >= MAX_TOKENS) break
  }
  return [...found].slice(0, MAX_TOKENS)
}
