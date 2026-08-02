import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

// ---------------------------------------------------------------------------
// Module 1 — Doctrine Knowledge Base. Searches the locally-extracted FD Books
// corpus (page-level chunks with book/chapter/page provenance) with BM25.
//
// LOCAL ONLY: the index under server/data/doctrine/ is copyrighted FDNY
// material — gitignored, never served to the client wholesale (only short
// query-relevant snippets with citations), never bundled or uploaded.
//
// Honesty rules baked in: results below a relevance floor return an explicit
// "not found in the corpus" instead of a weak guess, and every hit carries
// its full citation (book, chapter/document, page).
// ---------------------------------------------------------------------------

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../data/doctrine')
const INDEX_PATH = resolve(DATA_DIR, 'doctrine-index.json.gz')
const REPORT_PATH = resolve(DATA_DIR, 'doctrine-report.json')

export interface DoctrineChunk {
  /** Topic id (publication), e.g. 'ffp1', 'engine', 'ladder', 'mayday'. */
  t: string
  /** Book title, e.g. "FFP Vol. 1 — Firefighting Procedures". */
  b: string
  /** Chapter/document title. */
  d: string
  /** Relative file path inside the corpus (for local provenance only). */
  f: string
  /** 1-based page number. */
  p: number
  /** Extracted page text. */
  x: string
}

export interface DoctrineHit {
  topic: string
  book: string
  doc: string
  page: number
  score: number
  /** Fraction of distinct query terms present on the page (0..1). */
  coverage: number
  snippet: string
}

const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were will with'.split(' '),
)

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

class Bm25Index {
  private chunks: DoctrineChunk[] = []
  /** Per-page term frequencies + lengths — NOT raw token arrays. Retaining
   *  1.39M token strings cost ~70 MB heap and made every query rescan the
   *  whole corpus per term; tf lookup is a Map.get. */
  private docTf: Map<string, number>[] = []
  private docLen: number[] = []
  private df = new Map<string, number>()
  private avgLen = 0
  loading = false
  ready = false
  report: Record<string, unknown> | null = null

  /** Lazy entry point: the index loads on FIRST doctrine use, not at boot —
   *  a tsx watch restart (every dev file save) pays nothing until someone
   *  actually opens Ask the Manuals. Idempotent. */
  ensureLoaded(): void {
    if (!this.ready && !this.loading) this.load()
  }

  load(): void {
    if (this.loading || this.ready) return
    this.loading = true
    if (!existsSync(INDEX_PATH)) {
      this.loading = false
      console.warn('[doctrine] no index at server/data/doctrine — run: python3 server/scripts/build_doctrine_index.py')
      return
    }
    if (existsSync(REPORT_PATH)) {
      try {
        this.report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'))
      } catch {
        this.report = null
      }
    }
    // Stream-decompress off the hot path; the server stays responsive.
    const started = Date.now()
    const gunzip = createGunzip()
    const parts: Buffer[] = []
    createReadStream(INDEX_PATH)
      .pipe(gunzip)
      .on('data', (c: Buffer) => parts.push(c))
      .on('end', () => {
        try {
          this.chunks = JSON.parse(Buffer.concat(parts).toString('utf8')) as DoctrineChunk[]
        } catch (err) {
          console.error('[doctrine] index parse failed:', err)
          this.loading = false
          return
        }
        let total = 0
        for (const c of this.chunks) {
          const tokens = tokenize(c.x)
          const tf = new Map<string, number>()
          for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1)
          this.docTf.push(tf)
          this.docLen.push(tokens.length)
          total += tokens.length
          for (const tok of tf.keys()) this.df.set(tok, (this.df.get(tok) ?? 0) + 1)
        }
        this.avgLen = total / Math.max(1, this.chunks.length)
        this.ready = true
        this.loading = false
        console.log(
          `[doctrine] ${this.chunks.length} pages from ${String(this.report?.pdfs ?? '?')} PDFs ready in ${Date.now() - started} ms`,
        )
      })
      .on('error', (err) => {
        this.loading = false
        console.error('[doctrine] index load failed:', err)
      })
  }

  /** BM25 top-k. `topic` narrows to one publication (doctrine.lookup). */
  search(query: string, limit = 6, topic?: string): DoctrineHit[] {
    if (!this.ready) return []
    const qTokens = [...new Set(tokenize(query))]
    if (!qTokens.length) return []
    const N = this.chunks.length
    const k1 = 1.5
    const b = 0.75
    const scored: { i: number; score: number; matched: number }[] = []
    for (let i = 0; i < N; i++) {
      const c = this.chunks[i]
      if (topic && c.t !== topic) continue
      const len = this.docLen[i]
      if (!len) continue
      const tfMap = this.docTf[i]
      let score = 0
      let matched = 0
      for (const q of qTokens) {
        const df = this.df.get(q)
        if (!df) continue
        const tf = tfMap.get(q) ?? 0
        if (!tf) continue
        matched++
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / this.avgLen))
      }
      if (score > 0) scored.push({ i, score, matched })
    }
    scored.sort((a, bb) => bb.score - a.score)
    return scored.slice(0, limit).map(({ i, score, matched }) => {
      const c = this.chunks[i]
      return {
        topic: c.t,
        book: c.b,
        doc: c.d,
        page: c.p,
        score: Math.round(score * 10) / 10,
        coverage: Math.round((matched / qTokens.length) * 100) / 100,
        snippet: snippetFor(c.x, qTokens),
      }
    })
  }
}

/** ~380-char window centered on the densest cluster of query terms. */
function snippetFor(text: string, qTokens: string[]): string {
  const lower = text.toLowerCase()
  let best = 0
  let bestCount = -1
  const windowLen = 380
  for (let start = 0; start < Math.max(1, text.length - windowLen / 2); start += 120) {
    const win = lower.slice(start, start + windowLen)
    let count = 0
    for (const q of qTokens) if (win.includes(q)) count++
    if (count > bestCount) {
      bestCount = count
      best = start
    }
  }
  const raw = text.slice(best, best + windowLen).trim()
  return (best > 0 ? '…' : '') + raw + (best + windowLen < text.length ? '…' : '')
}

export const doctrine = new Bm25Index()

/** Results below this floor mean "the corpus does not answer this" — say so. */
export const MIN_RELEVANT_SCORE = 6
