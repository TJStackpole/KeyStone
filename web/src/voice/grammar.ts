// ---------------------------------------------------------------------------
// Prompt 15 — Tier A: the local deterministic command grammar.
//
// This is a DATA TABLE, not code: every command is a row in COMMANDS below.
// Extending the voice vocabulary = adding a row (patterns + examples); the
// executor lives in registry.ts keyed by intent id. matchGrammar() runs in
// well under a millisecond and works fully offline — Tier A commands never
// touch the network or the LLM tier.
//
// The Deepgram keyword lexicon is GENERATED from this table (buildLexicon),
// so the ASR vocabulary and the grammar can never drift apart.
// ---------------------------------------------------------------------------

export interface ParsedIntent {
  intent: string
  slots: Record<string, string>
}

export interface CommandSpec {
  intent: string
  /** Regexes over the normalized transcript. Named groups become slots. */
  patterns: RegExp[]
  /** Shown in the help panel; also feeds the generated ASR lexicon. */
  examples: string[]
  /** Help panel grouping. */
  group: string
}

// ---- transcript normalization ---------------------------------------------

const ONES: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9,
}
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
}

/**
 * Fold spoken number-word runs into digit strings, radio style:
 *   "twenty six"        -> "26"
 *   "one eighteen"      -> "118"   (concatenate groups)
 *   "six one eight two" -> "6182"  (box numbers read digit-by-digit)
 * "hundred" is dropped — "one hundred eighteen" still folds to "118".
 */
export function foldSpokenNumbers(text: string): string {
  const words = text.split(' ')
  const out: string[] = []
  let digits = ''
  const flush = () => {
    if (digits) out.push(digits)
    digits = ''
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === 'hundred') continue
    if (w in TENS) {
      const next = words[i + 1]
      if (next && next in ONES && ONES[next] > 0) {
        digits += String(TENS[w] + ONES[next])
        i++
      } else digits += String(TENS[w])
    } else if (w in TEENS) {
      digits += String(TEENS[w])
    } else if (w in ONES) {
      digits += String(ONES[w])
    } else if (/^\d+$/.test(w)) {
      digits += w
    } else {
      flush()
      out.push(w)
    }
  }
  flush()
  return out.join(' ')
}

/** Lowercase, strip punctuation, fold number words, collapse whitespace. */
export function normalizeTranscript(raw: string): string {
  const lowered = raw
    .toLowerCase()
    .replace(/[.,!?;:"()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return foldSpokenNumbers(lowered)
}

// Exposure slot homophone hardening: after the word "exposure"/"side", bias
// to digits ("exposure to" -> 2, "exposure for" -> 4, "exposure won" -> 1).
const EXPO = '(?<n>1|2|3|4|one|won|two|to|too|three|tree|four|for|fore)'
export function exposureDigit(word: string): number {
  const map: Record<string, number> = {
    '1': 1, one: 1, won: 1,
    '2': 2, two: 2, to: 2, too: 2,
    '3': 3, three: 3, tree: 3,
    '4': 4, four: 4, for: 4, fore: 4,
  }
  return map[word] ?? 0
}

// ---- unit designators ------------------------------------------------------

/** Spoken apparatus type -> callsign prefix, matching the sim roster
 *  (E-10, L-118, TL-9, R-01, SQ-41, BC-01, DC-01, M-02...). */
export const UNIT_PREFIXES: Record<string, string> = {
  engine: 'E',
  ladder: 'L',
  truck: 'L',
  'tower ladder': 'TL',
  rescue: 'R',
  squad: 'SQ',
  battalion: 'BC',
  'battalion chief': 'BC',
  chief: 'BC',
  division: 'DC',
  medic: 'M',
  ambulance: 'M',
  ems: 'M',
  drone: 'UAS',
}

const UNIT_WORDS = Object.keys(UNIT_PREFIXES).sort((a, b) => b.length - a.length)
const UNIT_RE = new RegExp(`\\b(?<kind>${UNIT_WORDS.join('|')})\\s+(?<num>\\d{1,4})\\b`)

/** Parse "ladder 118" / "engine 10" out of a normalized transcript. */
export function parseUnitPhrase(text: string): { kind: string; num: string; prefix: string } | null {
  const m = UNIT_RE.exec(text)
  if (!m?.groups) return null
  const kind = m.groups.kind
  return { kind, num: m.groups.num, prefix: UNIT_PREFIXES[kind] }
}

// ---- the command table ------------------------------------------------------

const SIDE = '(?<side>north|south|east|west|front|rear|back|left|right)'
const LAYER =
  '(?<layer>hydrants?|traffic|street names?|streets|roads?|road network|tunnels?|tax lots|lots|wind|collapse zones?|battalions?|divisions?|firehouses|fdny buildings|precincts|hospitals|footprints|buildings|target box)'
const AGENCY = '(?<agency>nypd|papd|ems|fdny|oem|nycem|dot|con ed(?:ison)?)'
const PAGE =
  '(?<page>map|tactical map|command board|board|riding lists?|decision log|log|resource ledger|resources|ledger|dispatch|dispatch comms)'
const UNIT_SLOT = `(?<unit>(?:${UNIT_WORDS.join('|')})\\s+\\d{1,4})`

export const COMMANDS: CommandSpec[] = [
  // ---- size-up views -------------------------------------------------------
  {
    intent: 'show_exposure',
    group: 'SIZE-UP',
    patterns: [
      new RegExp(`\\b(?:show|view|go to|open|check)\\s+(?:the\\s+)?exposure\\s+${EXPO}\\b`),
      new RegExp(`^exposure\\s+${EXPO}\\b`),
    ],
    examples: ['show exposure two', 'exposure four'],
  },
  {
    intent: 'show_side',
    group: 'SIZE-UP',
    patterns: [
      new RegExp(`\\b(?:show|view|look at)\\s+(?:the\\s+)?${SIDE}\\s+(?:side|face|facade|view)\\b`),
      new RegExp(`^${SIDE}\\s+side$`),
    ],
    examples: ['show the north side', 'look at the rear face'],
  },
  {
    intent: 'street_view',
    group: 'SIZE-UP',
    patterns: [/\b(?:street view|show (?:me )?the street|panorama|street level)\b/],
    examples: ['street view'],
  },
  {
    intent: 'oblique_view',
    group: 'SIZE-UP',
    patterns: [/\b(?:oblique(?: view)?|aerial view|overhead imagery)\b/],
    examples: ['oblique view'],
  },
  {
    intent: 'assign_exposures',
    group: 'SIZE-UP',
    patterns: [
      new RegExp(`\\b(?:assign|set|mark)\\s+(?:the\\s+)?exposures?(?:\\s+(?:from\\s+)?(?:the\\s+)?${SIDE})?\\b`),
    ],
    examples: ['assign exposures from the south'],
  },

  // ---- camera (ISOLATE battle views) --------------------------------------
  {
    intent: 'isolate_on',
    group: 'CAMERA',
    patterns: [/\bisolate (?:the )?(?:building|structure)\b/, /\bisolate (?:mode )?on\b/, /\benter isolate\b/],
    examples: ['isolate the building'],
  },
  {
    intent: 'isolate_off',
    group: 'CAMERA',
    patterns: [/\b(?:exit|leave|end) isolate\b/, /\bisolate (?:mode )?off\b/],
    examples: ['exit isolate'],
  },
  {
    intent: 'live_view',
    group: 'CAMERA',
    patterns: [/\blive views?\b/, /\bcamera rail\b/],
    examples: ['live view'],
  },
  {
    intent: 'orbit',
    group: 'CAMERA',
    patterns: [/\b(?:start |resume )?orbit\b/, /\b(?:rotate|spin) around\b/],
    examples: ['orbit', 'resume orbit'],
  },
  {
    intent: 'orbit_pause',
    group: 'CAMERA',
    patterns: [/\bpause (?:the )?orbit\b/, /\bstop (?:the )?(?:orbit|rotation|rotating|spinning)\b/],
    examples: ['pause the orbit'],
  },
  {
    intent: 'lock_top',
    group: 'CAMERA',
    patterns: [/\btop[- ]?down\b/, /\bbird'?s eye\b/, /\btop view\b/],
    examples: ['top down'],
  },
  {
    intent: 'lock_face',
    group: 'CAMERA',
    patterns: [new RegExp(`\\block (?:on |onto |to )?(?:the )?(?<side>north|east|south|west)\\b`)],
    examples: ['lock on the east'],
  },
  {
    intent: 'unlock_camera',
    group: 'CAMERA',
    patterns: [/\bunlock(?: the)?(?: camera)?\b/, /\bfree camera\b/, /\brelease the camera\b/],
    examples: ['unlock the camera'],
  },
  {
    intent: 'floor_up',
    group: 'CAMERA',
    patterns: [/\b(?:go |move )?up (?:a |one )?floor\b/, /\bfloor up\b/, /\bnext floor\b/],
    examples: ['up a floor'],
  },
  {
    intent: 'floor_down',
    group: 'CAMERA',
    patterns: [/\b(?:go |move )?down (?:a |one )?floor\b/, /\bfloor down\b/, /\bprevious floor\b/],
    examples: ['down a floor'],
  },
  {
    intent: 'floor_set',
    group: 'CAMERA',
    patterns: [/\b(?:go to |show |jump to )?floor (?<floor>\d{1,3})\b/],
    examples: ['floor 6'],
  },

  // ---- map navigation ------------------------------------------------------
  {
    intent: 'zoom_building',
    group: 'MAP',
    patterns: [/\b(?:zoom|go|fly) (?:in )?(?:to |on )?(?:the )?(?:building|incident|fire building|scene)\b/],
    examples: ['zoom to the building'],
  },
  {
    intent: 'zoom_staging',
    group: 'MAP',
    patterns: [/\b(?:zoom|go|fly) to (?:the )?staging\b/, /\bshow (?:the )?staging area\b/],
    examples: ['zoom to staging'],
  },
  {
    intent: 'zoom_cp',
    group: 'MAP',
    patterns: [/\b(?:zoom|go|fly) to (?:the )?command post\b/, /\bshow (?:the )?command post\b/],
    examples: ['zoom to the command post'],
  },
  {
    intent: 'zoom_unit',
    group: 'MAP',
    patterns: [new RegExp(`\\b(?:zoom|go|fly) to ${UNIT_SLOT}\\b`)],
    examples: ['zoom to ladder 118'],
  },
  {
    intent: 'where_is_unit',
    group: 'MAP',
    patterns: [
      new RegExp(`\\bwhere(?: is|'?s) ${UNIT_SLOT}\\b`),
      new RegExp(`\\bfind ${UNIT_SLOT}\\b`),
    ],
    examples: ['where is engine 10', 'find ladder 118'],
  },
  {
    intent: 'go_home',
    group: 'MAP',
    patterns: [/\b(?:go )?home\b/, /\bcity view\b/, /\breset (?:the )?view\b/],
    examples: ['go home'],
  },
  {
    intent: 'north_up',
    group: 'MAP',
    patterns: [/\bnorth up\b/, /\bface north\b/, /\breorient\b/],
    examples: ['north up'],
  },

  // ---- layers + basemap ----------------------------------------------------
  {
    intent: 'layer_show',
    group: 'LAYERS',
    patterns: [new RegExp(`\\b(?:show|display|turn on|enable)\\s+(?:the\\s+)?${LAYER}\\b`)],
    examples: ['show hydrants', 'turn on traffic'],
  },
  {
    intent: 'layer_hide',
    group: 'LAYERS',
    patterns: [new RegExp(`\\b(?:hide|turn off|disable|remove|clear)\\s+(?:the\\s+)?${LAYER}\\b`)],
    examples: ['hide traffic', 'turn off collapse zones'],
  },
  {
    intent: 'base_sat',
    group: 'LAYERS',
    patterns: [/\bsatellite(?: view| map)?\b/, /\bsat view\b/, /\bimagery basemap\b/],
    examples: ['satellite view'],
  },
  {
    intent: 'base_dark',
    group: 'LAYERS',
    patterns: [/\bdark (?:map|mode|basemap)\b/, /\bnight map\b/],
    examples: ['dark map'],
  },
  {
    intent: 'base_light',
    group: 'LAYERS',
    patterns: [/\blight (?:map|mode|basemap)\b/, /\bday(?:light)? map\b/],
    examples: ['light map'],
  },

  // ---- pages + panels ------------------------------------------------------
  {
    intent: 'open_page',
    group: 'PANELS',
    patterns: [
      new RegExp(`\\b(?:open|show|go to|switch to)\\s+(?:the\\s+)?${PAGE}\\b`),
    ],
    examples: ['show the command board', 'open the riding list', 'go to the map'],
  },
  {
    intent: 'start_par',
    group: 'PANELS',
    patterns: [/\bstart (?:a )?par\b/, /\bbegin par\b/, /\bpar check\b/],
    examples: ['start PAR'],
  },
  {
    intent: 'open_comms',
    group: 'PANELS',
    patterns: [/\b(?:open|show) (?:the )?(?:comms|radio(?: panel)?)\b/],
    examples: ['open comms'],
  },
  {
    intent: 'open_tactics',
    group: 'PANELS',
    patterns: [/\b(?:open |show )?(?:the )?tactics(?: panel| engine)?\b/],
    examples: ['show tactics'],
  },
  {
    intent: 'open_manuals',
    group: 'PANELS',
    patterns: [/\b(?:open |show |ask )?(?:the )?manuals\b/],
    examples: ['open the manuals'],
  },
  {
    intent: 'open_feeds',
    group: 'PANELS',
    patterns: [/\b(?:open|show) (?:the )?(?:feed health|live feeds|feeds)\b/],
    examples: ['show the feeds'],
  },
  {
    intent: 'open_packet',
    group: 'PANELS',
    patterns: [/\b(?:open|show) (?:the )?response packet\b/],
    examples: ['open the response packet'],
  },
  {
    intent: 'open_street_panel',
    group: 'PANELS',
    patterns: [/\b(?:open|show) (?:the )?street view panel\b/],
    examples: ['open the street view panel'],
  },

  // ---- dispatch audio ------------------------------------------------------
  {
    intent: 'dispatch_play',
    group: 'AUDIO',
    patterns: [
      /\bplay (?:the )?(?<which>fdny|fire|ems)\s+dispatch\b/,
      /\bplay (?:the )?(?<which>full)? ?dispatch\b/,
    ],
    examples: ['play the FDNY dispatch', 'play full dispatch'],
  },
  {
    intent: 'dispatch_stop',
    group: 'AUDIO',
    patterns: [/\bstop (?:the )?(?:dispatch|audio|playback)\b/],
    examples: ['stop the audio'],
  },

  // ---- comms + requests (CONFIRM class — drafted, never auto-sent) ---------
  {
    intent: 'tak_open',
    group: 'COMMS',
    patterns: [new RegExp(`\\b(?:open )?tak chat (?:to|with) ${AGENCY}\\b`)],
    examples: ['open TAK chat to NYPD'],
  },
  {
    intent: 'tak_send',
    group: 'COMMS',
    patterns: [new RegExp(`\\b(?:tell|message|send to) ${AGENCY}\\b\\s+(?:that\\s+)?(?<message>.{3,200})`)],
    examples: ['tell NYPD we need the block closed'],
  },
  {
    intent: 'request_resource',
    group: 'COMMS',
    patterns: [new RegExp(`\\brequest\\s+(?<desc>.{3,120}?)\\s+from\\s+${AGENCY}\\b`)],
    examples: ['request a bus from EMS'],
  },

  // ---- incident lifecycle (CONFIRM class) ----------------------------------
  {
    intent: 'transmit_alarm',
    group: 'INCIDENT',
    patterns: [
      /\b(?:transmit|strike) (?:a |the )?(?<alarm>2nd|3rd|4th|5th|second|third|fourth|fifth)(?: alarm)?\b/,
    ],
    examples: ['transmit a second alarm'],
  },
  {
    intent: 'respond_box',
    group: 'INCIDENT',
    patterns: [/\brespond to box (?<box>\d{2,4})\b/, /\bpress box (?<box>\d{2,4})\b/],
    examples: ['respond to box 6182'],
  },
  {
    intent: 'end_incident',
    group: 'INCIDENT',
    patterns: [/\b(?:end|close|terminate) (?:the )?incident\b/],
    examples: ['end the incident'],
  },
  {
    intent: 'run_demo',
    group: 'INCIDENT',
    patterns: [/\brun (?:the )?demo(?: scenario)?\b/, /\bstart (?:the )?demo\b/],
    examples: ['run the demo'],
  },
  {
    intent: 'stop_scenario',
    group: 'INCIDENT',
    patterns: [/\b(?:stop|cancel) (?:the )?(?:drill|demo|scenario)\b/],
    examples: ['stop the drill'],
  },

  // ---- voice layer itself --------------------------------------------------
  {
    intent: 'replies_on',
    group: 'VOICE',
    patterns: [/\bvoice replies on\b/, /\benable voice replies\b/, /\bspeak (?:your )?(?:answers|replies)\b/],
    examples: ['voice replies on'],
  },
  {
    intent: 'replies_off',
    group: 'VOICE',
    patterns: [/\bvoice replies off\b/, /\bdisable voice replies\b/, /\bstop speaking\b/],
    examples: ['voice replies off'],
  },
  {
    intent: 'glove_toggle',
    group: 'VOICE',
    patterns: [/\bglove mode (?<state>on|off)\b/, /\bbig buttons (?<state>on|off)\b/],
    examples: ['glove mode on'],
  },
  {
    intent: 'voice_help',
    group: 'VOICE',
    patterns: [/\bwhat can i say\b/, /\bvoice (?:help|commands)\b/, /^help$/, /\bshow (?:the )?commands\b/],
    examples: ['what can I say'],
  },

  // ---- tap-only surfaces (DENY class — routed so the refusal explains why) --
  {
    intent: 'par_confirm',
    group: 'DENIED',
    patterns: [
      new RegExp(`\\b(?:mark|confirm|log) par (?:complete|done|good)?(?:\\s*(?:for)?\\s*${UNIT_SLOT})?\\b`),
      /\bpar (?:is )?complete\b/,
    ],
    examples: ['mark PAR complete for Engine 7 → refused (tap-only)'],
  },
  {
    intent: 'mayday_ack',
    group: 'DENIED',
    patterns: [/\b(?:acknowledge|ack|clear|cancel) (?:the )?mayday\b/],
    examples: ['acknowledge the mayday → refused (tap-only)'],
  },
  {
    intent: 'riding_modify',
    group: 'DENIED',
    patterns: [
      /\b(?:add|remove|change|edit|swap)\b.{0,40}\briding list\b/,
      /\briding list\b.{0,20}\b(?:add|remove|change|edit|swap)\b/,
    ],
    examples: ['add a member to the riding list → refused (tap-only)'],
  },
]

// While a confirm chip is up, these two intents short-circuit everything else.
const CONFIRM_RE = /^(?:confirm|affirmative|affirm|yes|send it|do it|execute)\b/
const CANCEL_RE = /^(?:cancel|negative|no|abort|belay(?: that)?|never ?mind)\b/

/** Tier A matcher. `confirmPending` switches the grammar into the two-word
 *  confirm/cancel vocabulary first so "confirm" never collides with commands. */
export function matchGrammar(raw: string, confirmPending = false): ParsedIntent | null {
  const text = normalizeTranscript(raw)
  if (!text) return null
  if (confirmPending) {
    if (CONFIRM_RE.test(text)) return { intent: 'confirm_pending', slots: {} }
    if (CANCEL_RE.test(text)) return { intent: 'cancel_pending', slots: {} }
  }
  for (const cmd of COMMANDS) {
    for (const re of cmd.patterns) {
      const m = re.exec(text)
      if (m) {
        const slots: Record<string, string> = {}
        for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) slots[k] = v
        return { intent: cmd.intent, slots }
      }
    }
  }
  return null
}

// ---- generated ASR lexicon --------------------------------------------------

/** Keyword/vocabulary boost list for the streaming ASR tier, derived from the
 *  grammar so the two can't drift: command verbs + fireground vocabulary +
 *  unit designators + agencies. */
export function buildLexicon(): string[] {
  const words = new Set<string>()
  for (const cmd of COMMANDS) {
    for (const ex of cmd.examples) {
      for (const w of ex.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
        if (w.length >= 3 && !/^\d+$/.test(w)) words.add(w)
      }
    }
  }
  for (const w of UNIT_WORDS) for (const part of w.split(' ')) words.add(part)
  for (const w of ['exposure', 'par', 'mayday', 'fast', 'staging', 'command', 'post', 'tak',
    'nypd', 'papd', 'ems', 'nycem', 'oem', 'hydrants', 'battalion', 'division',
    'north', 'south', 'east', 'west', 'front', 'rear']) words.add(w)
  return [...words].sort()
}
