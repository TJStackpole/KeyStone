import { getAppState, setAppState } from '../state/store'

// ---------------------------------------------------------------------------
// SIMULATED dispatch audio for the ACTIVE incident — FDNY dispatch + EMS
// dispatch announcements generated from the live box (address, alarm, the
// real responding apparatus) and spoken with the browser's own speech
// synthesis. Keyless by design; every announcement SAYS it is simulated
// (the no-silent-simulation rule applies to audio too).
// ---------------------------------------------------------------------------

export interface DispatchScript {
  fdny: string
  ems: string
  box: string
}

/** Radio-style digits: E-207 -> "Engine 2 0 7" (spoken "two zero seven"). */
function spokenUnit(callsign: string): string {
  const m = callsign.match(/^([A-Za-z]+)-?(\d+)$/)
  if (!m) return callsign
  const digits = m[2].split('').join(' ')
  const word: Record<string, string> = {
    E: 'Engine',
    L: 'Ladder',
    TL: 'Tower Ladder',
    BC: 'Battalion',
    SQ: 'Squad',
    R: 'Rescue',
    EMS: 'EMS unit',
    PD: 'NYPD unit',
    OEM: 'OEM unit',
    UAS: 'UAS',
  }
  return `${word[m[1].toUpperCase()] ?? m[1]} ${digits}`
}

function boroughOf(address: string): string {
  for (const b of ['Manhattan', 'Brooklyn', 'Bronx', 'Queens', 'Staten Island']) {
    if (address.toLowerCase().includes(b.toLowerCase())) return b
  }
  // Free-typed addresses may not carry one — a neutral desk beats a wrong one.
  return 'Citywide'
}

/** Deterministic 4-digit box from the incident id — same box every replay. */
function boxNumber(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 9000
  return String(1000 + h)
}

/** Announcements built from the LIVE box — null when nothing is up. */
export function buildDispatchScript(): DispatchScript | null {
  const s = getAppState()
  const inc = s.incident
  if (!inc) return null
  const apparatus = Object.values(s.units).filter((u) => !u.callsign.includes('/'))
  const say = (cs: string[]) => cs.map(spokenUnit).join(', ')
  const engines = apparatus.filter((u) => u.category === 'engine').map((u) => u.callsign)
  const ladders = apparatus.filter((u) => u.category === 'ladder').map((u) => u.callsign)
  const chiefs = apparatus.filter((u) => u.category === 'battalion').map((u) => u.callsign)
  const special = apparatus.filter((u) => u.category === 'rescue').map((u) => u.callsign)
  const ems = apparatus.filter((u) => u.category === 'ems').map((u) => u.callsign)
  const feed = s.dispatchFeed.find((f) => f.id === s.focusedFeedId)
  const borough = feed?.borough ?? boroughOf(inc.address)
  const box = boxNumber(inc.id)
  const address = inc.address.split(',')[0]
  const type = (inc.type ?? 'structural fire').replace(/-/g, ' ')
  const fdnyUnits = [...engines, ...ladders, ...chiefs, ...special]
  const assignment = fdnyUnits.length
    ? `Responding: ${say(fdnyUnits)}.`
    : 'Assignment to follow — units pending dispatch.'
  const alarm = inc.alarmLevel && inc.alarmLevel !== '10-75' ? ` We are transmitting the ${inc.alarmLevel} for this box.` : ''
  return {
    box,
    fdny:
      `Simulated dispatch. ${borough} dispatch to all units: box ${box.split('').join(' ')}. ` +
      `Phone alarm, reported ${type} at ${address}. ${assignment}${alarm} ` +
      `${chiefs.length ? `${spokenUnit(chiefs[0])}, you are riding heavy. ` : ''}` +
      `${borough} dispatch, simulation ends.`,
    ems:
      `Simulated dispatch. EMS to the ${type}, box ${box.split('').join(' ')}, ${address}. ` +
      `${ems.length ? `${say(ems)}, respond.` : 'B L S and A L S units, respond.'} ` +
      `Stage at the FDNY command post, await assignment from the incident commander. ` +
      `EMS dispatch, simulation ends.`,
  }
}

let endGuard = 0

/** Speak one or both announcements. Returns false when speech synthesis is
 *  unavailable or no incident is up. */
export function playDispatch(kind: 'fdny' | 'ems' | 'both'): boolean {
  const script = buildDispatchScript()
  if (!script || typeof window === 'undefined' || !('speechSynthesis' in window)) return false
  stopDispatch()
  const texts = kind === 'both' ? [script.fdny, script.ems] : [script[kind]]
  const voices = window.speechSynthesis.getVoices()
  const voice =
    voices.find((v) => v.lang.startsWith('en-US') && /alex|daniel|aaron|fred|male/i.test(v.name)) ??
    voices.find((v) => v.lang.startsWith('en')) ??
    null
  const run = ++endGuard
  setAppState({ dispatchPlaying: kind })
  texts.forEach((t, i) => {
    const u = new SpeechSynthesisUtterance(t)
    if (voice) u.voice = voice
    u.rate = 1.05
    // The EMS dispatcher is a different desk — a slightly different register.
    u.pitch = i === 1 || kind === 'ems' ? 1.12 : 0.92
    if (i === texts.length - 1) {
      u.onend = () => {
        if (run === endGuard) setAppState({ dispatchPlaying: null })
      }
      u.onerror = () => {
        if (run === endGuard) setAppState({ dispatchPlaying: null })
      }
    }
    window.speechSynthesis.speak(u)
  })
  return true
}

export function stopDispatch(): void {
  endGuard++
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel()
  if (getAppState().dispatchPlaying) setAppState({ dispatchPlaying: null })
}
