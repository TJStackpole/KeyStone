import { useState } from 'react'
import { useMovable } from '../lib/movable'
import { useCapability } from '../profiles/manifest'
import { POLICY_FIELDS, usePolicy } from '../profiles/policy'
import { setAppState, useAppSlice } from '../state/store'

// ---------------------------------------------------------------------------
// Prompt 12 — the visibility-policy editor. Admin-only once identity exists;
// for the pilot it is reachable from the PANELS menu in both profiles. Every
// change PUTs to the server, which persists visibility-policy.json and
// broadcasts — all dashboards re-render against the new policy live (the
// "tighten it in a meeting without a deploy" path).
//
// What it deliberately CANNOT do: expose FDNY doctrine to NYCEM or grant
// command-board writes — those are manifest hardExclude entries, above any
// policy file.
// ---------------------------------------------------------------------------

export function PolicyEditorPanel() {
  const mvPolicyeditor = useMovable('policy-editor')
  const enabled = useCapability('admin.policy-editor')
  const { policyEditorOpen } = useAppSlice((s) => ({ policyEditorOpen: s.policyEditorOpen }))
  const policy = usePolicy()
  const [saving, setSaving] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  if (!enabled || !policyEditorOpen) return null

  const change = (key: string, value: string) => {
    setSaving(key)
    setFailed(false)
    void fetch('/api/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: { [key]: value } }),
    })
      .then((r) => {
        if (!r.ok) setFailed(true)
        // The store updates via the ws 'policy' broadcast — one authority.
      })
      .catch(() => setFailed(true))
      .finally(() => setSaving(null))
  }

  return (
    <aside {...mvPolicyeditor} className="policy-editor glass">
      <div className="policy-head">
        <span className="card-title">VISIBILITY POLICY · ADMIN</span>
        <button className="panel-close" onClick={() => setAppState({ policyEditorOpen: false })}>
          ✕
        </button>
      </div>
      <div className="policy-note">
        Cross-agency visibility is configuration, not code. Changes apply to every connected dashboard
        immediately — no reload, no deploy. Life-safety events (mayday/MCI) are never filtered, and manifest
        hard-exclusions (FDNY doctrine, command-board writes) sit above this policy.
      </div>
      {POLICY_FIELDS.map((f) => (
        <div key={f.key} className="policy-row" title={f.hint}>
          <div className="policy-label">
            <b>{f.label}</b>
            <i>{f.key}</i>
          </div>
          <select value={policy[f.key]} disabled={saving === f.key} onChange={(e) => change(f.key, e.target.value)}>
            {f.values.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
      ))}
      {failed && <div className="policy-failed">POLICY UPDATE FAILED — SERVER UNREACHABLE</div>}
    </aside>
  )
}
