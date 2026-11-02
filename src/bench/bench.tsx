import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { reportText, runBench, type BenchProgress } from './run'
import css from './bench.module.css'

const MESSAGES = 100_000
const PHASES: Record<BenchProgress['phase'], string> = {
  seed: 'Writing messages',
  index: 'Indexing',
  measure: 'Measuring',
  clean: 'Cleaning up',
}

/** The screen going dark freezes the page and spoils the numbers. Not every browser can stop that. */
async function keepScreenOn(): Promise<(() => void) | null> {
  try {
    const lock = await navigator.wakeLock.request('screen')
    return () => void lock.release().catch(() => {})
  } catch {
    return null
  }
}

function Bench() {
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [report, setReport] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const start = async () => {
    setRunning(true)
    setReport(null)
    setCopied(false)
    const release = await keepScreenOn()
    try {
      const result = await runBench({
        messages: MESSAGES,
        onProgress: (p) => setStatus(`${PHASES[p.phase]}: ${p.done.toLocaleString('en-US')} of ${p.total.toLocaleString('en-US')}`),
      })
      setReport(reportText(result))
      setStatus('Done. The test data is deleted.')
    } catch (e) {
      setStatus(`The run failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      release?.()
      setRunning(false)
    }
  }

  const copy = () => {
    if (report === null) return
    navigator.clipboard.writeText(report).then(
      () => setCopied(true),
      () => setStatus("Couldn't copy. Select the text instead."),
    )
  }

  return (
    <main className={css.page}>
      <h1 className={css.title}>Search index bench</h1>
      <p className={css.warning}>This takes 20 minutes or more and uses battery. Plug in the phone and keep this page open. Your chats and your key are not touched, and nothing leaves the phone.</p>
      <div className={css.row}>
        <button className={css.button} onClick={() => void start()} disabled={running}>
          Start
        </button>
        <button className={css.button} onClick={copy} disabled={report === null}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {status !== '' && (
        <p className={css.progress} role="status">
          {status}
        </p>
      )}
      {report !== null && <pre className={css.report}>{report}</pre>}
    </main>
  )
}

export function mountBench(el: HTMLElement): void {
  createRoot(el).render(<Bench />)
}
