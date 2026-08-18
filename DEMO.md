# KeyStone — 5-minute demo script

Anyone can run this. Start with `npm run share` (public URL) or `npm run ship`
(local), open the link, and follow the beats. The app opens in **COMMAND**
view — the simple mode; the **ADVANCED** chip (top right) reveals everything.

## Beat 1 — Stand up a fire (30s)
Press **▶ RUN THE DEMO** on the welcome card (or search *100 Gold Street* and
press ACTIVE INCIDENT). The camera drops to the block; real NYC building
footprints, the first-alarm assignment, and live-tracked units appear.

> "Every building, hydrant, and parcel you see is live NYC Open Data. Every
> unit position is a genuine Cursor-on-Target track — a real ATAK phone shows
> up exactly the same way."

## Beat 2 — The chief's first glance (60s)
Point at the **SIZE-UP card** (top right): stories, built year, occupancy,
live wind, exposures, units, and the three nearest hydrants **with
distances**. Tap a hydrant's distance chip — the map jumps to it. Assign an
engine from the dropdown — it lands on the incident log.

> "This is the arrival size-up without touching a radio: construction,
> occupancy, water, wind — one glance."

Tap **TAP TO ASSIGN** on exposures — the four sides label themselves,
Exposure 1 on the street side, FDNY convention.

## Beat 3 — Voice (60s)
Hold the **mic button** (bottom right) or hold **SPACE**:
- *"show hydrants"* · *"satellite view"* · *"where is Engine 10"*
- *"isolate the building"* → the block clears away, the building auto-orbits;
  *"show exposure two"*, *"up a floor"*, *"street view"*
- *"transmit a second alarm"* → nothing happens until the **CONFIRM** card is
  tapped — anything state-changing is drafted first. *"Mark PAR complete"*
  is **refused** — accountability stays tap-only, by design.

## Beat 4 — The record (60s)
Open **LOG** (bottom tabs): every benchmark, alarm, and note with server
timestamps. One tap prints the **ICS-214** or the full **COMMAND PACK** —
units, water assignments, activity, open requests — the relieving chief's
handoff. Open **DISPATCH** for the citywide simulated CAD feed and per-box
FDNY/EMS dispatch audio (clearly labeled SIMULATED).

## Beat 5 — Close (30s)
Tap **ADVANCED** — overlays (battalions, collapse zones, traffic, tax lots),
Ask-the-Manuals, tactics cards, deep building intel, TAK chat. Then tap it
off.

> "The full depth is one switch away, but a chief never needs a training
> class for the first ten minutes — that's the point."

**Reset between runs:** END the incident (incident card ✕ END — tap twice,
the second tap confirms), or say *"end the incident"* and confirm.

**Bring the welcome card back after rehearsing:** the RUN THE DEMO hero shows
once per browser. Before the real run, open the app with `?hero` on the URL
(e.g. `http://localhost:4010/?hero`) and it returns.
