import { stemmer as finnishStem } from '@orama/stemmers/finnish'
import { stem as englishStem } from 'porter2'

const WORD = /[\p{L}\p{N}]+/gu
/** Longer than any real word, Finnish compounds too. A pasted blob must not fill the index. */
const MAX_WORD = 64

/** Lower-cased words in reading order. NFC first: a phone keyboard can send ä as two code points. */
export function wordsOf(text: string): string[] {
  const words = text.normalize('NFC').toLowerCase().match(WORD) ?? []
  return words.filter((w) => w.length <= MAX_WORD)
}

/** One word as the index holds it: raw, Finnish stem, English stem. The language of a word is not known, so both stems go in. */
export const wordTokens = (word: string): string[] => [...new Set([word, finnishStem(word), englishStem(word)])].filter((t) => t !== '')

/** Raw words plus Finnish and English Snowball stems, deduped and lower-cased. `ä` and `ö` stay: folding merges different words. */
export const tokens = (text: string): string[] => [...new Set(wordsOf(text).flatMap(wordTokens))]
