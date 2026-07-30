import { buildGeoChatXml, type ChatMsg } from './tak/chat.js'
import type { Unit } from './units.js'

// ---------------------------------------------------------------------------
// Simulated GeoChat traffic: when a clearly-labeled simulated unit (WT-SIM-/
// DRILL-) ARRIVES on scene, it posts an arrival message into its agency's
// chat room — as genuine b-t-f CoT through the real TAK server, so the
// dashboard (and any real ATAK phone) receives it exactly like a human
// transmission. This is the inbound side of the interagency comm
// architecture; the operator answers from the OEM console in the chat panel.
// ---------------------------------------------------------------------------

/** Agency chat rooms (plus the ATAK-standard broadcast room). */
export const CHAT_ROOMS = ['FDNY', 'NYPD', 'EMS', 'PAPD', 'OEM'] as const

const ARRIVED = new Set(['On Scene', 'Onscene', 'Operating', 'Staged'])

/** Per-category arrival phraseology (a couple of variants each, picked
 * deterministically per callsign so repeats read naturally). */
const LINES: Record<string, string[]> = {
  engine: ['10-84 on scene, securing a hydrant', '10-84, stretching a line'],
  ladder: ['10-84 on scene, forcing entry', '10-84, throwing ladders'],
  battalion: ['on scene, establishing command', '10-84, assuming command'],
  rescue: ['10-84, reporting to command', 'on scene, tools to the door'],
  ems: ['84 on scene, setting up treatment', '84, staging ambulances'],
  nypd: ['on scene, closing the block to traffic', 'on scene, crowd control up'],
  esu: ['on scene, staging entry team', 'on scene, rigging for rescue'],
  papd: ['on location, facility liaison up', 'on location, coordinating access'],
  oem: ['on scene, opening interagency coordination', 'on scene, watch command notified'],
}

function roomFor(agency: string): string {
  switch (agency) {
    case 'FDNY':
      return 'FDNY'
    case 'EMS':
      return 'EMS'
    case 'NYPD':
      return 'NYPD'
    case 'PAPD':
      return 'PAPD'
    case 'OEM':
      return 'OEM'
    default:
      return 'All Chat Rooms'
  }
}

export class SimUnitChatter {
  private lastStatus = new Map<string, string>()
  private announced = new Set<string>()
  private counter = 0

  constructor(
    private publish: (xml: string) => boolean,
    /** Local record (same pattern as the operator's sends): the message shows
     * even if the TAK server doesn't fan custom rooms back; the echo, when it
     * does arrive, dedupes by id. */
    private record: (msg: ChatMsg) => void,
  ) {}

  /** New incident / drill: every unit announces again on its next arrival. */
  reset(): void {
    this.lastStatus.clear()
    this.announced.clear()
  }

  forget(uid: string): void {
    this.lastStatus.delete(uid)
    this.announced.delete(uid)
  }

  onUnit(u: Unit): void {
    if (!u.uid.startsWith('WT-SIM-') && !u.uid.startsWith('DRILL-')) return
    if (u.category === 'drone' || u.category === 'ff' || u.category === 'officer' || u.category === 'medic') return
    const prev = this.lastStatus.get(u.uid)
    this.lastStatus.set(u.uid, u.status ?? '')
    // Announce exactly once, on the transition INTO an arrived status.
    if (!u.status || !ARRIVED.has(u.status)) return
    if (prev !== undefined && ARRIVED.has(prev)) return
    if (this.announced.has(u.uid)) return
    this.announced.add(u.uid)
    const variants = LINES[u.category] ?? ['on scene']
    const line = variants[u.callsign.length % variants.length]
    const msgId = `${Date.now().toString(36)}${(this.counter++).toString(36)}`
    const room = roomFor(u.agency)
    const text = `${u.callsign} ${line}`
    this.publish(buildGeoChatXml(text, { uid: u.uid, callsign: u.callsign }, msgId, room))
    this.record({
      id: `GeoChat.${u.uid}.${room}.${msgId}`,
      from: u.callsign,
      room,
      text,
      ts: new Date().toISOString(),
      sim: true,
    })
  }
}
