import { PROFILE_LABEL, useProfile } from '../profiles/manifest'

/** Prompt 12 — subtle always-on profile watermark so screenshots and demo
 *  recordings are self-identifying ("KeyStone FDNY" / "KeyStone NYCEM"). */
export function ProfileWatermark() {
  const profile = useProfile()
  return <div className="profile-watermark">{PROFILE_LABEL[profile].toUpperCase()}</div>
}
