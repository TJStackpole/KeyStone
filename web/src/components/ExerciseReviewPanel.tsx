import { useEffect, useState } from 'react'
import { setAppState, useAppState } from '../state/store'
import type { AarDraft, AarMetric } from '../types'

// ---------------------------------------------------------------------------
// Prompt 11 Module 8 — facilitator review screen for a generated AAR draft.
// HSEEP AAR/IP structure; every auto-filled item shows its source events;
// the facilitator can edit anything before export. Export is PRINT-TO-PDF
// via a print stylesheet — KeyStone never auto-distributes.
// ---------------------------------------------------------------------------

export function ExerciseReviewPanel() {
  const { exerciseReview } = useAppState()
  const [rawDraft, setRawDraft] = useState<AarDraft | null>(null)
  const [library, setLibrary] = useState<{ id: string; scenario: string; startedAt: string; metrics: AarMetric[] }[]>([])
  const [saved, setSaved] = useState<'clean' | 'saved' | 'failed'>('clean')
  const draft = rawDraft
  // Any further edit invalidates "SAVED ✓" — a lit save indicator over
  // unsaved edits silently loses them when the panel closes.
  const setDraft = (next: AarDraft | null) => {
    setRawDraft(next)
    setSaved('clean')
  }

  useEffect(() => {
    setRawDraft(exerciseReview ? structuredClone(exerciseReview.aar) : null)
    setSaved('clean')
    if (exerciseReview) {
      fetch('/api/exercises')
        .then((r) => r.json())
        .then((b) => setLibrary(b.exercises ?? []))
        .catch(() => setLibrary([]))
    }
  }, [exerciseReview])

  if (!exerciseReview || !draft) return null
  const session = exerciseReview

  const save = async () => {
    try {
      const res = await fetch(`/api/exercises/${encodeURIComponent(session.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aar: draft }),
      })
      setSaved(res.ok ? 'saved' : 'failed')
    } catch {
      setSaved('failed') // server down mid-review — keep the draft, show it
    }
  }

  // Prior run of the SAME scenario: metric deltas across runs are the point
  // of the exercise library — improvement measured run over run.
  const prior = library.find((e) => e.scenario === session.scenario && e.id !== session.id)

  const editFinding = (list: 'strengths' | 'improvements', i: number, text: string) => {
    setDraft({ ...draft, [list]: draft[list].map((f, j) => (j === i ? { ...f, finding: text } : f)) })
  }

  return (
    <div className="exr-veil">
      <div className="exr-panel glass aar-print">
        <div className="exr-head">
          <span className="card-title">{draft.title}</span>
          <span className="exr-id">{session.id}</span>
          <div className="exr-btns noprint">
            <button onClick={() => void save()}>
              {saved === 'saved' ? 'SAVED ✓' : saved === 'failed' ? 'SAVE FAILED — RETRY' : 'SAVE EDITS'}
            </button>
            <button onClick={() => window.print()} title="Export via the system print dialog (PDF). Never auto-distributed.">
              EXPORT PDF
            </button>
            <button className="panel-close" onClick={() => setAppState({ exerciseReview: null })}>
              ✕
            </button>
          </div>
        </div>

        <div className="exr-section">
          <h3>1 · Exercise Overview</h3>
          <div className="exr-grid">
            <span>Exercise</span>
            <i>{draft.overview.exerciseName}</i>
            <span>Date</span>
            <i>{draft.overview.date}</i>
            <span>Duration</span>
            <i>{draft.overview.durationMin} min</i>
            <span>Scope</span>
            <i>{draft.overview.scope}</i>
            <span>Participating agencies</span>
            <i>{draft.overview.participatingAgencies.join(', ') || '—'}</i>
          </div>
        </div>

        <div className="exr-section">
          <h3>2 · Timeline of Key Events</h3>
          {draft.keyEvents.slice(0, 40).map((e, i) => (
            <div key={i} className="exr-row">
              <span className="exr-ts">{e.at.slice(11, 19)}</span>
              <span>{e.text}</span>
            </div>
          ))}
        </div>

        <div className="exr-section">
          <h3>3 · Objectives vs Observed Performance</h3>
          {draft.objectives.map((o, i) => (
            <div key={i} className="exr-obj">
              <b>{o.objective}</b>
              <i>{o.observed}</i>
              <span className={`exr-met ${o.met.replace(' ', '-')}`}>{o.met.toUpperCase()}</span>
            </div>
          ))}
        </div>

        <div className="exr-section">
          <h3>4 · Strengths</h3>
          {draft.strengths.map((f, i) => (
            <div key={i} className="exr-row">
              <textarea value={f.finding} onChange={(e) => editFinding('strengths', i, e.target.value)} />
              <span className="exr-src" title={f.sources.join('\n')}>
                {f.sources.length} source event{f.sources.length === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>

        <div className="exr-section">
          <h3>5 · Areas for Improvement (auto-flagged)</h3>
          {draft.improvements.length === 0 && <div className="exr-row">None auto-flagged.</div>}
          {draft.improvements.map((f, i) => (
            <div key={i} className="exr-row">
              <textarea value={f.finding} onChange={(e) => editFinding('improvements', i, e.target.value)} />
              <span className="exr-src" title={f.sources.join('\n')}>
                {f.sources.length} source event{f.sources.length === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>

        <div className="exr-section">
          <h3>6 · Improvement Plan</h3>
          <table className="exr-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Owner</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {draft.improvementPlan.map((row, i) => (
                <tr key={i}>
                  <td>{row.item}</td>
                  <td>
                    <input
                      value={row.owner}
                      placeholder="facilitator entry"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          improvementPlan: draft.improvementPlan.map((r, j) => (j === i ? { ...r, owner: e.target.value } : r)),
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={row.deadline}
                      placeholder="facilitator entry"
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          improvementPlan: draft.improvementPlan.map((r, j) =>
                            j === i ? { ...r, deadline: e.target.value } : r,
                          ),
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="exr-section">
          <h3>7 · Metrics {prior && <i className="exr-delta-note">vs prior run {prior.id}</i>}</h3>
          <table className="exr-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>This run</th>
                {prior && <th>Prior run</th>}
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {draft.metrics.map((m, i) => (
                <tr key={i}>
                  <td>{m.name}</td>
                  <td>
                    <b>{m.value}</b>
                  </td>
                  {prior && <td>{prior.metrics.find((p) => p.name === m.name)?.value ?? '—'}</td>}
                  <td title={m.sources.join('\n')}>{m.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="exr-foot">
          Generated {draft.generatedAt} by KeyStone from the immutable exercise event log · SIMULATED exercise data ·
          HSEEP AAR/IP structure (FEMA public standard) · draft for facilitator review — not distributed
        </div>
      </div>
    </div>
  )
}
