/** Deterministic drone -> stream mapping: drones sorted by callsign get drone1, drone2, … */
export function droneStreamFor(uid: string, droneUids: string[]): string {
  const idx = Math.max(0, droneUids.indexOf(uid))
  return `drone${(idx % 2) + 1}`
}
