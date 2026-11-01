// Live checks for the vault tool loop (spec section 15). Plain Node, no dependencies.
//
//   node scripts/live-check.mjs            run all six checks on four models
//   node scripts/live-check.mjs 1 5        run only checks 1 and 5
//
// SAFETY. The key is read from oddsandends.key (git-ignored) inside this script only.
// It is sent only to openrouter.ai. It is never printed or written anywhere. The script
// prints status codes, token counts and short error messages, nothing else. The /key
// response is never printed whole, because its `label` holds a partial key.
// The script stops when /key shows more than SPEND_STOP dollars used in total,
// or more than RUN_STOP dollars used since the start of this run.
//
// Requests are non-streaming, hand-built, and use the same top-level `cache_control`
// that ORFE sends for Anthropic models (src/lib/send.ts). Every check that reads
// `cached_tokens` first proves the cache is warm with a control (the identical
// request sent twice). A drop is only trusted when the control shows a hit.

import { readFileSync } from 'node:fs'

const KEY = readFileSync(new URL('../oddsandends.key', import.meta.url), 'utf8').trim()
const API = 'https://openrouter.ai/api/v1'
const SPEND_STOP = 2 // dollars, total on the key
const RUN_STOP = 0.6 // dollars, for this run
const WAIT = 4000 // ms between a write and the read that should hit it
const RUN = Math.random().toString(36).slice(2, 8) // keeps old caches from earlier runs out

const MODELS = [
  { id: 'anthropic/claude-haiku-5.5', short: 'haiku-5.5', reasoning: { effort: 'low' }, reasoning6: { effort: 'high' }, anthropic: true },
  { id: 'deepseek/deepseek-v4-flash', short: 'deepseek-v4-flash', reasoning: { effort: 'high' } },
  { id: 'openai/gpt-5.6-luna', short: 'gpt-5.6-luna', reasoning: { effort: 'low' } },
  { id: 'google/gemini-3.1-flash-lite', short: 'gemini-3.1-flash-lite', reasoning: { effort: 'low' } },
]
// Check 2 also covers an older DeepSeek, because reasoning rules differ between versions.
const DEEPSEEK_EXTRA = { id: 'deepseek/deepseek-v3.2', short: 'deepseek-v3.2', reasoning: { enabled: true } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// MODELS=haiku node scripts/live-check.mjs  runs only models whose short name contains the text.
const modelFilter = process.env.MODELS ?? ''
for (let i = MODELS.length - 1; i >= 0; i--) if (modelFilter && !MODELS[i].short.includes(modelFilter)) MODELS.splice(i, 1)
const only = process.argv.slice(2).map(Number)
const wants = (n) => only.length === 0 || only.includes(n)

// ---------- filler text ----------
// Natural sentences, numbered so each line differs. (Random word salad made Anthropic refuse.)
const SENTENCES = [
  'The harbour was quiet that morning and the fishermen mended their nets on the stone quay.',
  'A carpenter measured the old door twice before he cut the new frame.',
  'Rain fell on the orchard all afternoon, and the apples glistened in the grass.',
  'She kept a small notebook of train times in the pocket of her winter coat.',
  'The market opened at seven, and the baker sold out of rye bread by eight.',
  'Two children built a bridge of flat stones across the shallow stream.',
  'The lighthouse keeper wrote the weather in a ledger every evening before dinner.',
  'A copper kettle sat on the stove, and the kitchen smelled of lemon and tea.',
  'They walked along the river until the path turned toward the quiet village.',
  'The librarian found a worn map folded inside a book about mountain passes.',
  'He tuned the fiddle by the window while the snow gathered on the sill.',
  'The ferry crossed the lake twice a day, carrying mail, bread and a few passengers.',
  'Her garden had three rows of beans, a bed of herbs and a crooked wooden fence.',
  'The engineer checked every bolt on the bridge and signed the report in blue ink.',
  'Late in the evening the lamps were lit along the canal, one after another.',
  'A small brown rabbit sat very still at the edge of the meadow.',
  'The teacher handed out pencils and asked everyone to draw their street from memory.',
  'In the cellar they stored jars of plum jam, pickled beets and dry sand.',
  'The old compass still pointed north, though its glass was cracked across the middle.',
  'Wind pushed the clouds over the island, and the sea turned from grey to green.',
]
function prose(seed, nWords) {
  const out = []
  let n = 0
  for (let i = 0; n < nWords; i++) {
    const sentence = `Entry ${seed}-${i}: ${SENTENCES[(i * 7 + seed) % SENTENCES.length]}`
    out.push(sentence)
    n += sentence.split(' ').length
  }
  return out.join(' ')
}
const SYSTEM =
  `Run ${RUN}. You are a terse assistant in a software test. Answer briefly. ` +
  'Below is a long list of sample sentences. It only makes this message long enough.\n\n' +
  prose(1, 3600)
const BIG = 'Notes found for "river" (2 matches):\n' + prose(2, 800)
const POINTER = '[Result removed to save space: lookup "river" found 2 notes, ids n1 and n2.]'
const DESC = 'Look up notes by search words. Returns a short list of matches.'

const lookupTool = (desc) => ({
  type: 'function',
  function: {
    name: 'lookup',
    description: desc,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search words' } },
      required: ['query'],
    },
  },
})

// ---------- HTTP ----------
let startUsage = null
async function keyUsage() {
  const res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${KEY}` } })
  if (!res.ok) throw new Error(`/key failed with status ${res.status}`)
  const j = await res.json()
  return Number(j?.data?.usage ?? 0) // only this one field is ever read
}
async function guard(where) {
  const u = await keyUsage()
  if (startUsage === null) startUsage = u
  const delta = u - startUsage
  console.log(`[spend] ${where}: total used ${u.toFixed(4)} USD, this run ${delta.toFixed(4)} USD`)
  if (u > SPEND_STOP || delta > RUN_STOP) {
    console.log('[spend] limit reached, stopping')
    process.exit(2)
  }
  return u
}

const short = (s, n = 260) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n)

/** One chat call. Returns a plain object with the numbers; prints one line. */
async function call(label, model, messages, o = {}) {
  const body = {
    model: model.id,
    messages,
    max_tokens: 1500,
    stream: false,
    session_id: `lc-${RUN}-${model.short}`,
    tools: [lookupTool(o.desc ?? DESC)],
  }
  if (o.toolChoice) body.tool_choice = o.toolChoice
  const reasoning = o.reasoning === undefined ? model.reasoning : o.reasoning
  if (reasoning) body.reasoning = reasoning
  // PIN_PROVIDER=deepseek pins every call to one provider slug (no fallbacks).
  if (process.env.PIN_PROVIDER) body.provider = { order: [process.env.PIN_PROVIDER], allow_fallbacks: false }
  if (model.anthropic) body.cache_control = { type: 'ephemeral' }

  let res
  let j
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Title': 'orfe-live-check' },
        body: JSON.stringify(body),
      })
      j = await res.json().catch(() => ({}))
    } catch (e) {
      res = { status: 0 }
      j = { error: { message: `network: ${short(e?.message, 80)}` } }
    }
    if (res.status === 0 || res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      if (attempt === 0) {
        await sleep(3000)
        continue
      }
    }
    break
  }
  const u = j?.usage ?? {}
  const msg = j?.choices?.[0]?.message
  if (res.status === 200 && !msg) console.log(`  (diagnostic: 200 without a message; body keys: ${Object.keys(j ?? {}).join(',')}; finish: ${j?.choices?.[0]?.finish_reason}; choice error: ${short(JSON.stringify(j?.choices?.[0]?.error ?? null), 200)})`)
  const out = {
    label,
    model: model.short,
    status: res.status,
    ok: res.status === 200 && !!msg,
    err: j?.error ? short(`${j.error.message ?? ''} ${j.error.metadata?.raw ? '| ' + j.error.metadata.raw : ''}`, 300) : '',
    msg,
    provider: j?.provider ?? '',
    prompt: u.prompt_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    write: u.prompt_tokens_details?.cache_write_tokens ?? 0,
    compl: u.completion_tokens ?? 0,
    reason: u.completion_tokens_details?.reasoning_tokens ?? 0,
    cost: u.cost ?? 0,
    finish: j?.choices?.[0]?.finish_reason ?? '',
  }
  const tc = msg?.tool_calls?.length ? ` tool_calls=${msg.tool_calls.length}` : ''
  const rf = msg?.reasoning ? ' has_reasoning' : ''
  const rd = Array.isArray(msg?.reasoning_details) && msg.reasoning_details.length ? ` reasoning_details=${msg.reasoning_details.length}` : ''
  console.log(
    `  ${label.padEnd(26)} ${model.short.padEnd(22)} status=${out.status} prompt=${out.prompt} cached=${out.cached} write=${out.write} out=${out.compl} reasoning_tok=${out.reason} provider=${out.provider}${tc}${rf}${rd}` +
      (out.err ? ` ERROR: ${out.err}` : '') +
      (out.ok && !tc && !msg?.content ? ` EMPTY finish=${out.finish} native=${j?.choices?.[0]?.native_finish_reason} refusal=${short(msg?.refusal, 80)}` : '') +
      (out.ok && !tc && msg?.content ? ` text="${short(msg.content, 50)}"` : ''),
  )
  return out
}

// ---------- history building ----------
/** Keep only the fields that ORFE would store and send back. */
function stored(msg, keepReasoning) {
  const m = { role: 'assistant', content: msg.content ?? '' }
  if (msg.tool_calls?.length) m.tool_calls = msg.tool_calls
  if (keepReasoning) {
    if (msg.reasoning) m.reasoning = msg.reasoning
    if (msg.reasoning_details?.length) m.reasoning_details = msg.reasoning_details
  }
  return m
}
const U1 = { role: 'user', content: "Use the lookup tool once with the query 'river'. After the result arrives, reply with one short sentence." }
const U2 = { role: 'user', content: 'Reply with the single word hello and nothing else.' }
const U3 = { role: 'user', content: 'Reply with the single word bye and nothing else.' }
const U4 = { role: 'user', content: 'Reply with the single word ok and nothing else.' }
const U_LAKE = { role: 'user', content: "Now use the lookup tool once with the query 'lake'. After the result arrives, reply with one short sentence." }
const U_C6 = { role: 'user', content: 'Think about which single search word would best find a note on a body of water that freezes in winter, then use the lookup tool once with that word. After the result arrives, reply with one short sentence.' }
const SYS = { role: 'system', content: SYSTEM }

/**
 * A real finished tool turn plus two plain turns, produced by the model itself:
 * system, U1, a1 (tool call), t1 (big result), a2 (final text), U2, a3, U3, a4.
 * The raw replies are kept so a request can send reasoning or drop it.
 */
async function buildHistory(model) {
  const h = { model, ok: false }
  h.r1 = await call('build:round-1', model, [SYS, U1])
  const c1 = h.r1.msg?.tool_calls?.[0]
  if (!h.r1.ok || !c1) {
    console.log(`  build failed for ${model.short}: no tool call in round 1`)
    return h
  }
  h.a1raw = h.r1.msg
  h.t1id = c1.id
  h.r2 = await call('build:round-2', model, [SYS, U1, stored(h.a1raw, true), toolMsg(h, BIG)])
  if (!h.r2.ok) return h
  h.a2raw = h.r2.msg
  if (!h.a2raw.content) h.a2raw = { ...h.a2raw, content: 'Done.' }
  // Plain turns use the ORFE rule: reasoning dropped after the tool turn finished.
  h.keep = false
  let r3 = await call('build:plain-1 (no reasoning)', model, [...hist(h, {}), U2], { toolChoice: 'none' })
  if (!r3.ok) {
    // A model that needs its reasoning back: keep it and try again.
    h.keep = true
    r3 = await call('build:plain-1 (keep reasoning)', model, [...hist(h, {}), U2], { toolChoice: 'none' })
  }
  if (!r3.ok) return h
  h.a3 = stored(r3.msg, false)
  if (!h.a3.content) h.a3.content = 'hello'
  const r4 = await call('build:plain-2', model, [...hist(h, {}), U3], { toolChoice: 'none' })
  if (!r4.ok) return h
  h.a4 = stored(r4.msg, false)
  if (!h.a4.content) h.a4.content = 'bye'
  h.ok = true
  return h
}
const toolMsg = (h, content) => ({ role: 'tool', tool_call_id: h.t1id, content })

/**
 * Rendered history through the first plain turn (or through a4 when present).
 * opts.t1: tool result text. opts.keep: send reasoning for the finished turn.
 */
function hist(h, opts = {}) {
  const keep = opts.keep ?? h.keep
  const out = [SYS, U1, stored(h.a1raw, keep), toolMsg(h, opts.t1 ?? BIG), stored(h.a2raw, keep)]
  if (h.a3) out.push(U2, h.a3)
  if (h.a4) out.push(U3, h.a4)
  return out
}
/** The same history, with the tool steps flattened into one plain assistant message. */
function flatHist(h) {
  const out = [SYS, U1, { role: 'assistant', content: `(Looked in notes for 'river': found 2 notes.) ${h.a2raw.content}` }]
  if (h.a3) out.push(U2, h.a3)
  if (h.a4) out.push(U3, h.a4)
  return out
}

const results = [] // {check, model, ...}
const note = (check, model, data) => {
  results.push({ check, model, ...data })
}

// ---------- check 1: strip soon ----------
async function check1(h) {
  const m = h.model
  const full = [...hist(h), U4]
  const c1 = await call('c1 control-1', m, full)
  await sleep(WAIT)
  let c2 = await call('c1 control-2', m, full)
  let retried = false
  if (c2.ok && c2.cached === 0) {
    retried = true
    await sleep(8000)
    c2 = await call('c1 control-2 (retry)', m, full)
  }
  await sleep(WAIT)
  const stripped = [...hist(h, { t1: POINTER }), U4]
  const s = await call('c1 strip-t1', m, stripped)
  note(1, m.short, {
    through_u1: h.r1.prompt, // tokens up to and including the first user message
    control_cached: c2.cached,
    control_prompt: c2.prompt,
    strip_cached: s.cached,
    strip_prompt: s.prompt,
    control_valid: c2.cached > 0,
    retried,
    error: s.err || c2.err,
  })
}

// ---------- check 5: tool description change ----------
async function check5(h) {
  const m = h.model
  const full = [...hist(h), U4]
  const ctrl = await call('c5 control (same tools)', m, full)
  await sleep(WAIT)
  const ctrl2 = ctrl.cached > 0 ? ctrl : await call('c5 control (retry)', m, full)
  await sleep(WAIT)
  const changed = await call('c5 one word in tool desc', m, full, { desc: DESC + ' Use it freely.' })
  note(5, m.short, {
    control_cached: ctrl2.cached,
    control_prompt: ctrl2.prompt,
    changed_cached: changed.cached,
    changed_prompt: changed.prompt,
    control_valid: ctrl2.cached > 0,
    error: changed.err,
  })
}

// ---------- check 2: DeepSeek, which field keeps reasoning valid ----------
async function check2(h) {
  const m = h.model
  const variants = [
    ['none', {}],
    ['reasoning', (a) => ({ reasoning: a.reasoning })],
    ['reasoning_details', (a) => ({ reasoning_details: a.reasoning_details })],
    ['both', (a) => ({ reasoning: a.reasoning, reasoning_details: a.reasoning_details })],
    ['reasoning_content', (a) => ({ reasoning_content: a.reasoning })],
  ]
  const shape = (a, v) => {
    const base = stored(a, false)
    const extra = typeof v === 'function' ? v(a) : {}
    for (const k of Object.keys(extra)) if (extra[k] !== undefined && extra[k] !== null) base[k] = extra[k]
    return base
  }
  const row = { has_reasoning: !!h.a1raw.reasoning, has_details: !!h.a1raw.reasoning_details?.length }
  for (const [name, v] of variants) {
    // Stage A: inside the tool turn (assistant tool call + tool result, then continue).
    const a = await call(`c2 in-turn: ${name}`, m, [SYS, U1, shape(h.a1raw, v), toolMsg(h, BIG)])
    // Stage B: the next user turn after the finished tool turn.
    const b = await call(`c2 next-turn: ${name}`, m, [SYS, U1, shape(h.a1raw, v), toolMsg(h, BIG), shape(h.a2raw, v), U2])
    row[`inTurn_${name}`] = a.ok ? 'ok' : `${a.status} ${short(a.err, 120)}`
    row[`nextTurn_${name}`] = b.ok ? 'ok' : `${b.status} ${short(b.err, 120)}`
  }
  note(2, m.short, row)
}

// ---------- check 3 and 4: switching models ----------
async function check34(hs) {
  const okHs = hs.filter((h) => h.ok)
  for (const src of okHs) {
    for (const tgt of okHs) {
      if (src === tgt) continue
      const m = tgt.model
      // Check 3: raw steps (foreign ids) with the source model's reasoning still attached.
      const raw3 = [...hist(src, { keep: true }), U_LAKE]
      const r3 = await call(`c3 ${src.model.short}->`, m, raw3)
      // Check 4a: raw steps, foreign ids, reasoning dropped.
      const raw4 = [...hist(src, { keep: false }), U_LAKE]
      const r4a = await call(`c4 raw ${src.model.short}->`, m, raw4)
      // Check 4b: steps flattened into text, tools still sent.
      const r4b = await call(`c4 flat ${src.model.short}->`, m, [...flatHist(src), U_LAKE])
      note(3, `${src.model.short} -> ${m.short}`, { status: r3.status, ok: r3.ok, toolcall: !!r3.msg?.tool_calls?.length, error: r3.err })
      note(4, `${src.model.short} -> ${m.short}`, {
        raw_ok: r4a.ok,
        raw_status: r4a.status,
        raw_toolcall: !!r4a.msg?.tool_calls?.length,
        raw_error: r4a.err,
        flat_ok: r4b.ok,
        flat_status: r4b.status,
        flat_toolcall: !!r4b.msg?.tool_calls?.length,
        flat_error: r4b.err,
      })
    }
  }
}

// ---------- check 6: dropped reasoning after a finished tool turn ----------
async function check6(h) {
  const m = h.model
  const R6 = { reasoning: m.reasoning6 ?? m.reasoning }
  const base = hist(h, { keep: false })
  // A fresh tool turn on top of the history, so the warm point is exact.
  const ra = await call('c6 new turn: round-1', m, [...base, U_C6], R6)
  const c = ra.msg?.tool_calls?.[0]
  if (!ra.ok || !c) {
    note(6, m.short, { error: `no tool call in round 1: ${ra.err}` })
    return
  }
  const a1 = ra.msg
  const t = { role: 'tool', tool_call_id: c.id, content: 'Notes found for "lake" (1 match): lake-1, a short note about winter ice.' }
  await sleep(WAIT)
  const rb = await call('c6 round-2 (reasoning kept)', m, [...base, U_C6, stored(a1, true), t], R6)
  if (!rb.ok) {
    note(6, m.short, { error: `round 2 failed: ${rb.err}` })
    return
  }
  const a2 = rb.msg.content ? rb.msg : { ...rb.msg, content: 'Done.' }
  const U5 = { role: 'user', content: 'Reply with the single word fine and nothing else.' }
  await sleep(WAIT)
  const dropped = [...base, U_C6, stored(a1, false), t, stored(a2, false), U5]
  const d1 = await call('c6 next turn: dropped', m, dropped, R6)
  await sleep(WAIT)
  const d2 = await call('c6 next turn: dropped again', m, dropped, R6)
  await sleep(WAIT)
  const k1 = await call('c6 next turn: kept', m, [...base, U_C6, stored(a1, true), t, stored(a2, true), U5], R6)
  note(6, m.short, {
    through_round1_prompt: ra.prompt,
    through_round2_prompt: rb.prompt,
    round2_cached: rb.cached,
    dropped_ok: d1.ok,
    dropped_status: d1.status,
    dropped_cached: d1.cached,
    dropped_prompt: d1.prompt,
    dropped_again_cached: d2.cached,
    kept_ok: k1.ok,
    kept_cached: k1.cached,
    kept_prompt: k1.prompt,
    has_reasoning: !!a1.reasoning || !!a1.reasoning_details?.length,
    error: d1.err || k1.err,
  })
}

// ---------- main ----------
async function main() {
  await guard('start')
  const histories = []
  for (const m of MODELS) {
    console.log(`\n== building history: ${m.id}`)
    const h = await buildHistory(m)
    h.ok ? 0 : console.log(`  ${m.short}: history incomplete, skipping its checks`)
    histories.push(h)
    await guard(`after build ${m.short}`)
  }
  const good = histories.filter((h) => h.ok)

  if (wants(1)) {
    console.log('\n== check 1: strip soon')
    for (const h of good) await check1(h)
    await guard('after check 1')
  }
  if (wants(5)) {
    console.log('\n== check 5: tool description change')
    for (const h of good) await check5(h)
    await guard('after check 5')
  }
  if (wants(2)) {
    console.log('\n== check 2: DeepSeek with tools')
    for (const h of good.filter((x) => x.model.id.startsWith('deepseek/'))) await check2(h)
    console.log('  -- older DeepSeek')
    const h2 = await buildHistory(DEEPSEEK_EXTRA)
    if (h2.ok) await check2(h2)
    await guard('after check 2')
  }
  if (wants(3) || wants(4)) {
    console.log('\n== checks 3 and 4: switching models')
    await check34(good)
    await guard('after checks 3 and 4')
  }
  if (wants(6)) {
    console.log('\n== check 6: dropped reasoning')
    for (const h of good) await check6(h)
    await guard('after check 6')
  }

  console.log('\n== SUMMARY (json, one per line)')
  for (const r of results) console.log(JSON.stringify(r))
  const end = await keyUsage()
  console.log(`\n[spend] this run used ${(end - startUsage).toFixed(4)} USD`)
}

main().catch((e) => {
  console.log(`fatal: ${short(e?.message, 200)}`)
  process.exit(1)
})
