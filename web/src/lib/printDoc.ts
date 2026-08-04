import { notify } from '../components/NoticeChip'

// ---------------------------------------------------------------------------
// Printable one-pagers (BRIEF, ICS-214) — pop-up-blocker-proof. Preferred
// path is a real window (the operator can keep it open, print later, hand
// the tab to someone). When the browser blocks the window, we do NOT fail
// silently: the same document renders into a hidden same-origin iframe and
// the system print dialog opens directly, with a visible notice telling the
// operator how to get the full window back. Printing must work on a locked-
// down department tablet where nobody can touch browser settings.
// ---------------------------------------------------------------------------

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Shared serif print stylesheet — both documents read as one product. */
const PRINT_CSS = `
  body { font: 14px/1.5 Georgia, 'Times New Roman', serif; color: #111; margin: 40px; }
  h1 { font-size: 19px; letter-spacing: 0.02em; margin: 0 0 2px; }
  .sub { color: #555; font-size: 12px; margin-bottom: 18px; }
  .drill { border: 2px solid #b45309; color: #b45309; font-weight: 700; padding: 6px 10px; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 7px 10px; border-bottom: 1px solid #ddd; vertical-align: top; }
  td.l { width: 200px; font-weight: 700; }
  td.t { width: 90px; font-family: monospace; }
  .print { margin-top: 22px; padding: 9px 18px; font-size: 14px; cursor: pointer; }
  @media print { .print { display: none; } }
`

export interface PrintableDoc {
  /** Browser-tab title (escaped here). */
  title: string
  /** <h1> heading (escaped here). */
  heading: string
  /** Sub-line under the heading (escaped here). */
  sub: string
  /** Pre-escaped HTML for the body table rows etc. — caller escapes values. */
  bodyHtml: string
  /** Show the amber DRILL banner. */
  drill?: boolean
}

function docHtml(d: PrintableDoc): string {
  return `<!doctype html><html><head><title>${escapeHtml(d.title)}</title><style>${PRINT_CSS}</style></head><body>
<h1>${escapeHtml(d.heading)}</h1>
<div class="sub">${escapeHtml(d.sub)}</div>
${d.drill ? '<div class="drill">DRILL — EVERYTHING IN THIS DOCUMENT IS SIMULATED EXERCISE PLAY</div>' : ''}
${d.bodyHtml}
<button class="print" onclick="window.print()">Print / save as PDF</button>
</body></html>`
}

/**
 * Open the document in a new window; if the browser blocks pop-ups, fall
 * back to printing it through a hidden iframe. Returns true when a real
 * window opened (false = fallback path was used).
 */
export function openPrintable(d: PrintableDoc): boolean {
  const html = docHtml(d)
  // Some blockers return a truthy-but-neutered window instead of null —
  // writing to it throws. Treat any failure here as "blocked" and fall
  // through to the iframe path rather than dying inside the click handler.
  try {
    const w = window.open('', '_blank', 'width=760,height=900')
    if (w && !w.closed) {
      w.document.write(html)
      w.document.close()
      return true
    }
  } catch {
    // fall through to the iframe fallback below
  }
  // Blocked: same-origin hidden iframe → system print dialog. The iframe is
  // removed after printing (afterprint where supported, timeout as backstop).
  const frame = document.createElement('iframe')
  frame.style.position = 'fixed'
  frame.style.right = '0'
  frame.style.bottom = '0'
  frame.style.width = '0'
  frame.style.height = '0'
  frame.style.border = '0'
  frame.setAttribute('aria-hidden', 'true')
  frame.srcdoc = html
  frame.onload = () => {
    const cleanup = () => window.setTimeout(() => frame.remove(), 500)
    try {
      frame.contentWindow?.addEventListener('afterprint', cleanup)
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
      window.setTimeout(cleanup, 60_000) // backstop if afterprint never fires
    } catch {
      frame.remove()
      notify('PRINT FAILED — allow pop-ups for this site and try again', 'red')
    }
  }
  document.body.appendChild(frame)
  notify('POP-UP BLOCKED — opened the print dialog directly. Allow pop-ups for this site to get the full window.')
  return false
}
