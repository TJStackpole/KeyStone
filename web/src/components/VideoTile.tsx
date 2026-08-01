import type Hls from 'hls.js'
import { useEffect, useRef, useState } from 'react'
import { hlsUrl, playWhep, type WhepSession } from '../video/whep'

type FeedState = 'connecting' | 'live' | 'lost'

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

    const scheduleRetry = () => {
      if (!dead) {
        setState('lost')
        retry = setTimeout(connect, 4000)
      }
    }

    // Fallback for environments where WebRTC media can't flow: MediaMTX HLS.
    // hls.js is ~500 kB min — over half the app chunk — and most sessions
    // never reach this path, so it loads lazily right here instead of
    // riding the boot bundle.
    const connectHls = async () => {
      const video = videoRef.current
      if (dead || !video) return false
      const { default: HlsCtor } = await import('hls.js')
      if (dead) return false
      if (HlsCtor.isSupported()) {
        hls = new HlsCtor({ lowLatencyMode: true, liveDurationInfinity: true })
        hls.loadSource(hlsUrl(stream))
        hls.attachMedia(video)
        hls.on(HlsCtor.Events.FRAG_BUFFERED, () => {
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
        video.onloadeddata = () => !dead && setState('live')
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
        <span className={`tile-state${state === 'lost' ? ' lost' : ''}`}>
          {state === 'connecting' ? 'CONNECTING…' : 'FEED LOST — RETRYING'}
        </span>
      )}
    </div>
  )
}
