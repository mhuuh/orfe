/** What one model or host needs that the others do not. */
export interface ModelRule {
  /** Send a finished reply's reasoning_details too. Normally only the turn in flight sends them. */
  keepReasoning?: true
  /** Treat the model as having no tools. */
  noTools?: true
  /** Flatten every stored step, also the model's own. */
  flattenAll?: true
}

export interface PatternRule {
  pattern: RegExp
  rule: ModelRule
}

/**
 * One line per pattern, with a comment naming the check. The first match wins.
 *
 * Empty on purpose. See "Rules for modelRules.ts" in docs/research/live-checks-2026-11.md:
 * - Checks 2 and 6: five DeepSeek hosts took a next turn with no reasoning, so no model needs `keepReasoning`.
 * - Check 4: all four models take raw steps and flattened steps, so no model needs `noTools` or `flattenAll`.
 *
 * First-party DeepSeek was not reached, so it is untested. If it refuses a turn, add this line:
 *   { pattern: /^deepseek\//, rule: { keepReasoning: true } },
 */
const MODEL_RULES: PatternRule[] = []

let rules = MODEL_RULES

/** Test seam: swap the list. Call with no argument to reset. */
export function setModelRulesForTest(list: PatternRule[] = MODEL_RULES): void {
  rules = list
}

export function ruleFor(modelId: string): ModelRule {
  return rules.find((r) => r.pattern.test(modelId))?.rule ?? {}
}
