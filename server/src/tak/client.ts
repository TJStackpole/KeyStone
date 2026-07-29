import { EventEmitter } from 'node:events'
import net from 'node:net'
import { buildCotXml, parseCotXml, type CotEvent } from './cot.js'

/**
 * The dashboard's own EUD identity. TAK servers key per-client delivery off the
 * uid in a client's self-announcement — a silent socket receives no fan-out —
 * so WATCHTOWER announces itself exactly like an ATAK client would.
 */
const SELF_UID = 'WATCHTOWER-COP'
const SELF_CALLSIGN = 'WATCHTOWER'
// NYC City Hall — inert anchor for the dashboard's own presence marker.
const SELF_LAT = 40.7128
const SELF_LON = -74.006

const MAX_BUFFER = 1024 * 1024 // drop pathological buffers rather than OOM
const MAX_BACKOFF_MS = 15_000

/**
 * Persistent plain-TCP CoT client (TAK protocol version 0 — XML streaming).
 *
 * Connects to the TAK server's streaming port, receives every CoT event the
 * server fans out (simulator traffic and real ATAK clients alike), and can
 * publish CoT XML back into the server. Reconnects forever with backoff —
 * the dashboard must keep working while infrastructure flaps.
 *
 * Events: 'event' (CotEvent), 'status' (connected: boolean)
 */
export class TakClient extends EventEmitter {
  private socket: net.Socket | null = null
  private buffer = ''
  private backoff = 1000
  private stopped = false
  connected = false

  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {
    super()
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.socket?.destroy()
    this.socket = null
  }

  /** Publish raw CoT XML into the TAK server. Returns false if not connected. */
  send(xml: string): boolean {
    if (!this.socket || !this.connected) return false
    this.socket.write(xml)
    return true
  }

  private connect(): void {
    if (this.stopped) return
    const socket = net.connect({ host: this.host, port: this.port })
    this.socket = socket

    socket.on('connect', () => {
      this.connected = true
      this.backoff = 1000
      console.log(`[tak] connected to ${this.host}:${this.port} (plain-TCP CoT)`)
      socket.write(
        buildCotXml({
          uid: SELF_UID,
          callsign: SELF_CALLSIGN,
          type: 'a-f-G-U-C',
          lat: SELF_LAT,
          lon: SELF_LON,
          staleSeconds: 3600,
        }),
      )
      this.emit('status', true)
    })

    socket.on('data', (chunk) => this.onData(chunk.toString('utf8')))

    const onDown = (why: string) => {
      if (this.socket !== socket) return
      const wasConnected = this.connected
      this.connected = false
      this.socket = null
      this.buffer = ''
      if (wasConnected) {
        console.warn(`[tak] link down (${why}) — reconnecting`)
        this.emit('status', false)
      }
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
      }
    }

    socket.on('error', (err) => {
      if (this.connected) console.warn(`[tak] socket error: ${err.message}`)
      socket.destroy()
      onDown(`error: ${err.message}`)
    })
    socket.on('close', () => onDown('closed'))
  }

  /** Frame the TCP stream into complete <event>...</event> documents. */
  private onData(text: string): void {
    this.buffer += text
    if (this.buffer.length > MAX_BUFFER) {
      console.warn('[tak] rx buffer overflow — resetting framing')
      this.buffer = ''
      return
    }
    for (;;) {
      const start = this.buffer.indexOf('<event')
      if (start === -1) {
        this.buffer = ''
        return
      }
      const endTag = this.buffer.indexOf('</event>', start)
      const selfClose = findSelfClosingEventEnd(this.buffer, start)
      let end: number
      if (endTag !== -1 && (selfClose === -1 || endTag < selfClose)) {
        end = endTag + '</event>'.length
      } else if (selfClose !== -1) {
        end = selfClose
      } else {
        // incomplete event — keep from `start` and wait for more bytes
        this.buffer = this.buffer.slice(start)
        return
      }
      const xml = this.buffer.slice(start, end)
      this.buffer = this.buffer.slice(end)
      const ev = parseCotXml(xml)
      if (ev) this.emit('event', ev)
    }
  }
}

/** Index just past `/>` when the <event .../> tag at `start` is self-closing, else -1. */
function findSelfClosingEventEnd(buf: string, start: number): number {
  const close = buf.indexOf('>', start)
  if (close === -1) return -1
  return buf[close - 1] === '/' ? close + 1 : -1
}

export type { CotEvent }
