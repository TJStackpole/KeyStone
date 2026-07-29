import Hls from 'hls.js'
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
    const connectHls = () => {
      const video = videoRef.current
      if (dead || !video) return false
      if (Hls.isSupported()) {
        hls = new Hls({ lowLatencyMode: true, liveDurationInfinity: true })
        hls.loadSource(hlsUrl(stream))
        hls.attachMedia(video)
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (!dead) setState('live')
          void video.play().catch(() => undefined)
        })
        hls.on(Hls.Events.ERROR, (_e, data) => {
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
            if (!connectHls()) scheduleRetry()
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
            if (!connectHls()) scheduleRetry()
          }
        }
      } catch {
        if (!dead && !connectHls()) scheduleRetry()
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
