import { useEffect } from 'react'
import { setAppState, useAppSlice } from '../state/store'

/** Transient operator notice — visible failures instead of console.warn
 *  (popup-blocked dual-screen, refused facilitator actions). Auto-clears. */
export function NoticeChip() {
  const { uiNotice } = useAppSlice((s) => ({ uiNotice: s.uiNotice }))
  useEffect(() => {
    if (!uiNotice) return
    const t = setTimeout(() => setAppState({ uiNotice: null }), 7000)
    return () => clearTimeout(t)
  }, [uiNotice])
  if (!uiNotice) return null
  return (
    <button
      className={`ui-notice glass ${uiNotice.tone}`}
      onClick={() => setAppState({ uiNotice: null })}
      title="Dismiss"
    >
      {uiNotice.text}
    </button>
  )
}

export function notify(text: string, tone: 'amber' | 'red' = 'amber'): void {
  setAppState({ uiNotice: { text, tone } })
}
