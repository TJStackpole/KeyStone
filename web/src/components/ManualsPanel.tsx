import { useRef, useState } from 'react'
import { setAppState, useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// Module 1 — "Ask the Manuals": question in, cited passages out, straight
// from the locally-indexed FDNY publications corpus. Every result carries
// book · chapter/document · page. When the corpus doesn't answer, the panel
// says so explicitly instead of guessing.
// ---------------------------------------------------------------------------

interface DoctrineHit {
  topic: string
  book: string
  doc: string
  page: number
  score: number
  snippet: string
}

export function ManualsPanel() {
  const { manualsOpen } = useAppSlice((s) => ({ manualsOpen: s.manualsOpen }))
  const [question, setQuestion] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'answered' | 'empty' | 'offline' | 'unindexed'>('idle')
  const [hits, setHits] = useState<DoctrineHit[]>([])
  const seqRef = useRef(0)

  if (!manualsOpen) return null

  const ask = async () => {
    const q = question.trim()
    if (!q) return
    const seq = ++seqRef.current
    setState('loading')
    try {
      const res = await fetch(`/api/doctrine/ask?q=${encodeURIComponent(q)}`)
      const body = (await res.json()) as { ready: boolean; found: boolean; results: DoctrineHit[] }
      if (seq !== seqRef.current) return
      if (!body.ready) {
        setState('unindexed')
        setHits([])
        return
      }
      setHits(body.results)
      setState(body.found ? 'answered' : 'empty')
    } catch {
      if (seq !== seqRef.current) return
      setState('offline')
      setHits([])
    }
  }

  return (
    <section className="manuals-panel glass">
      <div className="panel-head">
        <span className="card-title">Ask the Manuals · FD Books</span>
        <span className="chip">
          <span className="dot" /> LOCAL CORPUS
        </span>
        <button className="panel-close" onClick={() => setAppState({ manualsOpen: false })}>
          ✕
        </button>
      </div>
      <div className="manuals-input">
        <input
          value={question}
          placeholder="e.g. attack stairway designation, tower ladder positioning…"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask()
          }}
        />
        <button disabled={!question.trim() || state === 'loading'} onClick={() => void ask()}>
          {state === 'loading' ? '…' : 'ASK'}
        </button>
      </div>
      <div className="manuals-scroll">
        {state === 'idle' && (
          <div className="intel-note">
            ANSWERS COME ONLY FROM THE FDNY PUBLICATIONS CORPUS ON THIS MACHINE — EVERY PASSAGE IS CITED
          </div>
        )}
        {state === 'unindexed' && (
          <div className="intel-note warn-note">
            CORPUS NOT INDEXED — RUN python3 server/scripts/build_doctrine_index.py AND RESTART
          </div>
        )}
        {state === 'offline' && <div className="intel-note warn-note">SERVER UNREACHABLE</div>}
        {state === 'empty' && (
          <div className="intel-note warn-note">
            THE CORPUS DOES NOT CONTAIN A RELEVANT PASSAGE FOR THIS QUESTION — NO ANSWER RATHER THAN A GUESS
          </div>
        )}
        {state === 'answered' &&
          hits.map((h, i) => (
            <div key={i} className="manual-hit">
              <div className="manual-cite">
                <b>{h.book}</b>
                <span> · {h.doc}</span>
                <span className="manual-page"> · p. {h.page}</span>
              </div>
              <div className="manual-snippet">{h.snippet}</div>
            </div>
          ))}
      </div>
    </section>
  )
}
