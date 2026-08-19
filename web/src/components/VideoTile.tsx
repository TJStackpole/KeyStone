import type Hls from 'hls.js'
import { useEffect, useRef, useState } from 'react'
import { hlsUrl, playWhep, type WhepSession } from '../video/whep'

type FeedState = 'connecting' | 'live' | 'lost' | 'offline'

/** The video sidecar can't be reached at all when the app is served over
 *  https (mixed content blocks http://host:8889 outright) — and endless
 *  FEED LOST retries read as a broken product. Detect the hopeless cases
 *  up front and show a calm, labeled offline card instead. */
function sidecarHopeless(): boolean {
  return location.protocol === 'https:'
}

/**
 * One video feed: WebRTC (WHEP) with auto-retry and a FEED LOST state, always
 * watermarked SIMULATED FEED (per CLAUDE.md every simulated element is labeled).
 */
export function VideoTile({
  stream,
  label,
  chip,
  onClick,
  selected,
}: {
  stream: string
  label: string
  chip?: string
  onClick?: () => void
  selected?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [state, setState] = useState<FeedState>('connecting')

  useEffect(() => {
    let session: WhepSession | null = null
    let hls: Hls | null = null
    let dead = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0

    if (sidecarHopeless()) {
      setState('offline')
      return () => undefined
    }

    const scheduleRetry = () => {
      if (dead) return
      attempts += 1
      // Three strikes: MediaMTX clearly isn't running (keyless/no-docker
      // deployment) — show the honest card, but keep a SLOW background probe
      // so feeds attach when the sidecar comes up mid-session.
      if (attempts >= 3) {
        setState('offline')
        retry = setTimeout(connect, 45_000)
        return
      }
      setState('lost')
      retry = setTimeout(connect, 4000)
    }

    // Fallback for environments where WebRTC media can't flow: MediaMTX HLS.
    // hls.js is ~500 kB min — over half the app chunk — and most sessions
    // never reach this path, so it loads lazily right here instead of
    // riding the boot bundle.
    const connectHls = async () => {
      const video = videoRef.current
      if (dead || !video) return false
      let HlsCtor: typeof Hls
      try {
        HlsCtor = (await import('hls.js')).default
      } catch {
        return false // chunk fetch failed (redeploy/network) — caller schedules the retry
      }
      if (dead) return false
      if (HlsCtor.isSupported()) {
        hls = new HlsCtor({ lowLatencyMode: true, liveDurationInfinity: true })
        hls.loadSource(hlsUrl(stream))
        hls.attachMedia(video)
        hls.on(HlsCtor.Events.FRAG_BUFFERED, () => {
          attempts = 0
          if (!dead) setState('live')
          void video.play().catch(() => undefined)
        })
        hls.on(HlsCtor.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            hls?.destroy()
            hls = null
            scheduleRetry()
          }
        })
        return true
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = hlsUrl(stream)
        video.onloadeddata = () => {
          attempts = 0
          if (!dead) setState('live')
        }
        video.onerror = scheduleRetry
        return true
      }
      return false
    }

    const connect = async () => {
      if (dead || !videoRef.current) return
      setState('connecting')
      try {
        session = await playWhep(videoRef.current, stream)
        if (dead) {
          session.stop()
          return
        }
        // WebRTC answers fast, but media only counts once frames decode; if no
        // frames arrive shortly, fall back to HLS rather than sitting dark.
        const video = videoRef.current
        const frameCheck = setTimeout(() => {
          if (!dead && video.readyState < 2) {
            session?.stop()
            session = null
            void connectHls().then((ok) => ok || scheduleRetry())
          }
        }, 4000)
        video.onloadeddata = () => {
          clearTimeout(frameCheck)
          attempts = 0 // healthy again — hiccups must not accumulate for life
          if (!dead) setState('live')
        }
        session.pc.onconnectionstatechange = () => {
          const s = session?.pc.connectionState
          if ((s === 'failed' || s === 'disconnected' || s === 'closed') && !dead && session) {
            session.stop()
            session = null
            void connectHls().then((ok) => ok || scheduleRetry())
          }
        }
      } catch {
        if (!dead) void connectHls().then((ok) => ok || scheduleRetry())
      }
    }
    void connect()

    return () => {
      dead = true
      if (retry) clearTimeout(retry)
      session?.stop()
      hls?.destroy()
    }
  }, [stream])

  return (
    <div className={`video-tile${selected ? ' selected' : ''}`} onClick={onClick}>
      <video ref={videoRef} autoPlay muted playsInline />
      <span className="sim-watermark">SIMULATED FEED</span>
      <span className="tile-label">
        {label}
        {chip && <i>{chip}</i>}
      </span>
      {state !== 'live' && (
        <span className={`tile-state${state === 'lost' ? ' lost' : state === 'offline' ? ' offline' : ''}`}>
          {state === 'connecting'
            ? 'CONNECTING…'
            : state === 'offline'
              ? 'VIDEO SIDECAR OFFLINE — feeds attach when MediaMTX is running'
              : 'FEED LOST — RETRYING'}
        </span>
      )}
    </div>
  )
}
