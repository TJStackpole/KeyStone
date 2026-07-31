import { XMLParser } from 'fast-xml-parser'

// ---------------------------------------------------------------------------
// TAK GeoChat: real b-t-f CoT to "All Chat Rooms", the broadcast chat every
// ATAK client subscribes to. Messages KeyStone sends appear on real phones on
// this TAK server, and their replies arrive back on the CoT stream.
// ---------------------------------------------------------------------------

export interface ChatMsg {
  id: string
  from: string
  room: string
  text: string
  ts: string
  self?: boolean
  /** Sender is a simulated unit (WT-SIM-/DRILL- uid) — labeled SIM in the UI. */
  sim?: boolean
  /** CoT uid of the sending EUD (chatgrp uid0) — lets ingest drop chat from a
   *  parallel dev stack's sim namespace (see sim/ns.ts). */
  senderUid?: string
}

function esc(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function buildGeoChatXml(
  text: string,
  sender: { uid: string; callsign: string },
  msgId: string,
  room = 'All Chat Rooms',
): string {
  const now = new Date()
  const stale = new Date(now.getTime() + 86_400_000)
  const iso = (d: Date) => d.toISOString()
  const uid = `GeoChat.${sender.uid}.${room}.${msgId}`
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(uid)}" type="b-t-f" how="h-g-i-g-o"` +
    ` time="${iso(now)}" start="${iso(now)}" stale="${iso(stale)}">` +
    `<point lat="40.7128000" lon="-74.0060000" hae="0.0" ce="9999999.0" le="9999999.0"/>` +
    `<detail>` +
    `<__chat parent="RootContactGroup" groupOwner="false" chatroom="${esc(room)}" id="${esc(room)}" senderCallsign="${esc(sender.callsign)}">` +
    `<chatgrp uid0="${esc(sender.uid)}" uid1="${esc(room)}" id="${esc(room)}"/>` +
    `</__chat>` +
    `<link uid="${esc(sender.uid)}" type="a-f-G-U-C" relation="p-p"/>` +
    `<remarks source="BAO.F.KEYSTONE.${esc(sender.uid)}" to="${esc(room)}" time="${iso(now)}">${esc(text)}</remarks>` +
    `</detail>` +
    `</event>\n`
  )
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  ignoreDeclaration: true,
  // Chat text must NEVER be numerically coerced — strnum turns a reply of
  // "10.50" into 10.5 and a gate code "007" into 7 on a coordination screen.
  parseTagValue: false,
})

interface Node {
  [k: string]: unknown
}

function first(n: unknown): Node | undefined {
  const v = Array.isArray(n) ? n[0] : n
  return v && typeof v === 'object' ? (v as Node) : undefined
}

/** Extract a GeoChat message from raw b-t-f CoT XML; null for non-chat events. */
export function extractGeoChat(raw: string, eventUid: string): ChatMsg | null {
  let doc: Node
  try {
    doc = parser.parse(raw) as Node
  } catch {
    return null
  }
  const event = first(doc.event)
  const detail = event ? first(event.detail) : undefined
  const chat = detail ? first(detail.__chat) : undefined
  const remarks = detail ? first(detail.remarks) : undefined
  if (!chat) return null
  const text =
    typeof detail?.remarks === 'string'
      ? (detail.remarks as string)
      : remarks && typeof remarks['#text'] !== 'undefined'
        ? String(remarks['#text'])
        : ''
  if (!text) return null
  // Sender uid (chatgrp uid0) tells us whether this is one of our clearly
  // labeled simulated units — the UI badges those SIM.
  const chatgrp = chat ? first(chat.chatgrp) : undefined
  const senderUid = String(chatgrp?.['@_uid0'] ?? '')
  return {
    id: eventUid,
    from: String(chat['@_senderCallsign'] ?? 'UNKNOWN'),
    room: String(chat['@_chatroom'] ?? 'All Chat Rooms'),
    text,
    ts: new Date().toISOString(),
    sim: senderUid.startsWith('WT-SIM-') || senderUid.startsWith('DRILL-') || undefined,
    senderUid: senderUid || undefined,
  }
}
