/**
 * Minimal WHEP (WebRTC-HTTP Egress Protocol) client for MediaMTX.
 * One POST of the offer SDP, answer comes back, media flows. No dependencies.
 */

export interface WhepSession {
  pc: RTCPeerConnection
  stop(): void
}

export function whepUrl(streamName: string): string {
  // MediaMTX WebRTC endpoint (docker-compose publishes 8889; CORS is open).
  return `http://${location.hostname}:8889/${streamName}/whep`
}

export function hlsUrl(streamName: string): string {
  return `http://${location.hostname}:8888/${streamName}/index.m3u8`
}

export async function playWhep(video: HTMLVideoElement, streamName: string): Promise<WhepSession> {
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  const stream = new MediaStream()
  pc.ontrack = (e) => {
    stream.addTrack(e.track)
    video.srcObject = stream
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  // Non-trickle: wait briefly for ICE gathering so the single POST carries candidates.
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve()
    const check = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
    setTimeout(resolve, 1500)
  })

  const res = await fetch(whepUrl(streamName), {
    method: 'POST',
    headers: { 'content-type': 'application/sdp' },
    body: pc.localDescription?.sdp ?? '',
  })
  if (!res.ok) {
    pc.close()
    throw new Error(`WHEP ${res.status} for ${streamName}`)
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })

  return {
    pc,
    stop() {
      pc.close()
      video.srcObject = null
    },
  }
}
