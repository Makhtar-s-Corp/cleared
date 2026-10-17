---
name: Cleared Cockpit
version: 0.3.0
basedOn: "Vercel / Geist design language, adapted. Not an official Vercel system."
colors:
  canvas: "#FAFAFA"
  surface: "#FFFFFF"
  surface-muted: "#F4F4F4"
  hairline: "#EAEAEA"
  outline: "rgba(0,0,0,0.08)"
  text: "#171717"
  text-secondary: "#4D4D4D"
  text-muted: "#666666"
  text-faint: "#707070"  # darkened from #8F8F8F so that text reaches 4.5:1 (section 8)
  ink: "#171717"
  on-ink: "#FFFFFF"
  awaiting: "#F5A623"
  awaiting-text: "#AB570A"
  awaiting-surface: "#FFFBF2"
  awaiting-highlight: "#FCE2B3"
  awaiting-pill: "#FFF8EB"  # the banner of a state chosen on purpose, and the chip of a ticket that waits
  success: "#16A34A"
  success-text: "#15803D"  # success as text on white; #16A34A stays for dots, outlines and fills
  success-surface: "#F2FBF5"
  danger: "#EE0000"
  link: "#0070F3"
  stage-progress: "#0070F3"
  stage-checks: "#7928CA"
  stage-review: "#0A9DB0"
  harness-claude: "#D97757"
  harness-codex: "#10A37F"
  harness-other: "#8F8F8F"
typography:
  sans: "Geist, -apple-system, 'Segoe UI', Arial, sans-serif"
  mono: "'Geist Mono', ui-monospace, monospace"
  scale:
    display: { size: 40, weight: 600, tracking: -0.045em, line: 1.1 }
    title: { size: 24, weight: 600, tracking: -0.035em, line: 1.2 }
    card-title: { size: 15, weight: 600, tracking: -0.01em, line: 1.35 }
    body: { size: 14, weight: 400, line: 1.45 }
    meta: { size: 12, weight: 400, line: 1.4 }
    welcome: { size: 28, weight: 600, tracking: -0.03em, line: 1.2 }
    column-title: { size: 13, weight: 500, family: sans, transform: none }
    id: { size: 12, weight: 400, family: mono, color: text-faint }
    stat: { size: 26, weight: 600, tracking: -0.03em }
radius:
  chip: 999
  control: 8
  card: 12
  device: 16
spacing: [2, 4, 6, 8, 10, 12, 14, 16, 18, 24, 28, 32, 40]
elevation:
  outline: "0 0 0 1px rgba(0,0,0,0.08)"
  card: "0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04)"
  awaiting: "0 0 0 1px rgba(245,166,35,0.55), 0 8px 24px -8px rgba(245,166,35,0.45)"
  device-after: "0 0 0 1.5px rgba(22,163,74,0.55), 0 8px 20px -6px rgba(22,163,74,0.35)"
  header: "0 1px 0 rgba(0,0,0,0.08)"
motion:
  duration: 200ms
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)"
breakpoints:
  phone: 390
  tablet: 768
  desktop: 1280
---

# Cleared Cockpit

Reference mockups: `reference/cockpit-v5-desktop.html` (the tower with the porthole open, on a computer) and `reference/porthole-phone.html` (porthole on a phone). Open them in a browser and match them. When this file and the mockups disagree, this file wins. (`reference/tower.html` is the earlier, superseded tower.)

## 1. Visual theme and atmosphere

Light, precise, calm. A developer tool in the spirit of Vercel's dashboard: near-white canvas, white cards outlined by a one-pixel shadow instead of a border, black for actions, grey for everything that does not ask for attention. The interface disappears; the work shows.

One rule above all: **amber is reserved for what waits for the human.** An approval, a question. If amber appears anywhere else, nothing stands out any more.

**No gradients, anywhere.** Not on text, not on backgrounds, not on borders, not on avatars, not on progress bars, not as patterns. Every color is flat. Progress that is partly done is a filled bar inside an empty bar, not a two-stop gradient.

Light is the primary theme; the computer is the primary screen, the phone secondary. The dark theme, chosen with a button and never imposed by the system, follows the same roles with other values.

**A state the owner chose on purpose is never a fault.** The test mode that shares the service account is a banner in amber, in plain words ("Test mode: the agents share the service account"), never a red alert and never a code. Red is for a real failure only: a rollback, a health problem, a lost connection.

## 2. Color roles

- **Ink** (`ink`): the only fill for the primary action (the main button, the selected screen pill) and the logo.
- **Awaiting** (`awaiting`): the 3 px top stripe and the glow of a card that waits for the human, the column marker of "Awaiting you", the amber line that opens a card or the chip of the porthole, the hairline under a recommendation (`awaiting-highlight`), and the banner of a state chosen on purpose (`awaiting-pill`). Text on amber backgrounds uses `awaiting-text` for contrast. A question card sits on `awaiting-surface`.
- **Stages**: each column has a dot and its segment of the progress rail in its stage color. In progress `stage-progress`, Checks `stage-checks`, Review `stage-review`, Awaiting you `awaiting`. Nowhere else.
- **Harness**: a small square in the harness color in the squad list, and the fuel bar of that subscription. Claude `harness-claude`, Codex `harness-codex`, others `harness-other`. Never used for a state.
- **State**: `success` for green checks, a clean release, healthy, the "after" side of a before/after; `danger` for a rollback, a failure, a negative figure in a "before". Never both on the same card except in a before/after pair.
- **Text**: `text` for titles and values, `text-secondary` for body on cards, `text-muted` for labels, `text-faint` for ticket ids and times.

## 3. Typography

- Geist for every word and every figure (duration, time, model name, percentage), with tabular figures. **Geist Mono only for ticket ids and commit ids**, small and grey (`id`, 12 px, `text-faint`). It is never a costume for "technical".
- Titles use tight negative tracking (display -0.045em, title -0.035em). Never positive tracking.
- Column names and section labels are Geist, sentence case, medium weight (`column-title`). No uppercase, no letter-spacing, anywhere.
- Ticket titles are the most important text of a card. Never truncated on desktop; up to three lines.
- One display line per screen: the welcome sentence on the tower.

## 4. Components

### Header
White, `elevation.header`. Left: logo (black triangle), product name, a slash, the project switcher (flat amber dot, project name, chevron). Centre-left: view tabs (Tower, Landed, Fuel, Rules), active tab on a 5% black fill. Right: the banner of a chosen state when there is one (`awaiting-pill`, amber dot, plain words), a danger pill only when something is really wrong (danger dot and the problem in plain words; nothing when all is well), the age of the snapshot in very small grey ("updated 8 s ago"), avatar (black circle, white initial). On a phone the banner takes its own full-width row under the tabs.

### Welcome sentence
One sentence instead of counters: "One thing is waiting for you.", "Two things are waiting for you.", "Nothing needs you." (`welcome`, 28 px), then one grey line (`text-muted`): the fuel left per subscription, what is under way, what landed today ("Claude 81% left · 1 team in review · nothing landed today"). No date line, no name.

### Counters
The detailed counters (in flight, landed today, first-time clean, median Todo to Done, one 6 px bar of fuel per subscription in its harness color) sit in a folded block under the board until the Fuel tab exists. Never a currency.

### Ticket card
- White, radius `card`, `elevation.card`, padding 18.
- The title on top, bold (`card-title`), never truncated on desktop; up to three lines.
- A rail of four 4 px segments for a ticket in progress, filled in the stage color.
- One line at the bottom: a plain sentence on the left ("Sonnet reviews, round 2"; the blue live dot only for a team really running), the ticket id on the right in mono, small and grey.
- A ticket that waits for the human starts with one amber line ("To approve · for 53 min", "Question · for 12 min"). No harness square, no usage share, no meta row.
- Only a ticket with a Cleared team has a card in a column. The tracker's other tickets are folded into one line under the board ("5 tracker tickets without a Cleared team"), expandable.
- An empty column says in one grey sentence, in a dashed box, what to do to fill it.

**Awaiting, ready to land:** same white card, 3 px flat `awaiting` stripe on top, `elevation.awaiting`, a black "Ready to land" chip. The line at the bottom reads "Opus · 1 h 24 · Checks green". No thumbnails on the card: the captures are in the porthole.

**Awaiting, question:** `awaiting-surface` background, amber outline, an outlined "Question" chip in `awaiting-text`, the question's first sentence as the title (never cut), the rest of the question and the team's recommendation in at most three lines each, the number of choices, the ticket title in `text-muted`, and a footer with "Read it all and answer" in `awaiting-text` and the id.

**Tracker only** (in the approval status of the tracker, no request from Cleared): listed in the folded line under the board, `surface-muted`, hairline outline, no stripe, no chip, no amber. Nothing to clear.

**Queued** (waiting for a machine slot): `surface-muted`, 1 px dashed border `#D4D4D4`, no shadow, title in `text-secondary`, one sentence with the reason.

### Live dot
6 px circle in `stage-progress` with a 3 px halo at 15% opacity, slow pulse. Only on a squad actually running. Stops with reduced motion.

### Landed today
White outlined table at the bottom of the tower: time, what shipped (plain title), model, outcome with a small dot ("Clean first time" and "One review round" in `success`, "Rolled back 11:49" in `danger`). A "View all" link on the right of its header.

### Porthole
Computer (1280 and above): right panel under the header (560 px, 640 from 1440), the board making room and showing two columns with what waits first. Tablet (1024 to 1279): the panel covers the board. Below 1024 px and on a phone: full page with a back button, the ticket id and the status chip in a white header.
Order, always:
1. The ticket title, large (`title`), under a 3 px × 56 px flat amber bar when it waits for the human, and "Waiting since 16:05 (1 h 35)".
2. **The question put to the human, in bold, in one sentence** ("Allow this change to go live?"), then **what changes for the user in one or two sentences**, taken from the team's report (never an internal agent note; the pull request number is dropped). With no report: "No summary provided by the team". For a question ticket, the whole question in bold on `awaiting-surface`, the team's recommendation below a highlight hairline.
3. **One single large before / after pair**, side by side in device frames (radius `device`, 6 px white bezel, after with `elevation.device-after`). A Phone / Desktop switch above it (it changes the frame only), one pill per screen below it when there are several; the other captures are one click away, never a row of thumbnails. A click enlarges a capture. A ticket with no screen shows one concrete before / after example and its tests instead.
4. A small block of facts: who wrote and who reviewed, the size of the change with the link to the pull request (and "draft"), the checks, the time worked, the share of the week's usage when measured.
5. Folded: the team's report, the squad, the black box.
- The action panel stays at the bottom, with a hairline: "Send back" (outline) and "Clear to land" (solid ink) side by side, **one commit** in small mono under the label of the main button (all versions it clears stay in its accessible name and tooltip). At most 36 % of the height on a computer, 60 % on a phone; while the porthole has more below, the panel casts a soft shadow upward.
- The click asks for a passkey, then a **grace bar** appears: a 4 px flat track with an ink fill that empties over 60 seconds, "Clearing in 42 s" and an ink "Undo". After the write the card says "Cleared by you at 14:02, landing" until the next snapshot. A question's options are outlined buttons above a text field. Without a passkey (or a secure address) the buttons are disabled and say why. Nothing pretends to act.

## 5. Layout

- Desktop: header, welcome sentence and grey line, four-column board (two columns while the porthole is open), the folded lines, Landed today. Side margins 32 px, column gap 20 px, card gap 12 px. Room to breathe: nothing touches.
- Cards awaiting the human are always first in their column.
- Phone: one column. Awaiting cards first, then the rest by stage. The porthole is a page of its own with the buttons fixed at the bottom; the before / after pair stacks below 360 px; nothing overflows.
- An empty column says in one `text-faint` sentence what to do to fill it. No illustrations, no decoration.

## 6. Depth

Three levels: canvas, card (one-pixel shadow outline plus a 2 px soft shadow), awaiting card (amber outline plus an amber soft shadow). No other shadows, except the scroll cue of the porthole's action panel (section 4). Borders are shadows or hairlines, never thick.

## 7. Do's and don'ts

- Do keep amber for the human. Do keep black for actions.
- Do show exact model names, real times and real counts.
- Do write every status as a plain sentence read in one second.
- Don't use gradients. Ever.
- Don't show money. Fuel is a share of a subscription.
- Don't add icons for decoration.
- Don't truncate ticket titles on desktop.
- Don't animate anything but the live dot and state changes (200 ms).

## 8. Responsive behavior and accessibility

- Breakpoints 390, 768, 1280.
- Touch targets at least 44 px.
- Contrast at least 4.5:1 for text, including `awaiting-text` on `awaiting-surface`.
- Keyboard: every card focusable, Enter opens the porthole, Escape closes it, visible focus ring in `link`.
- Reduced motion respected.

## 9. Prompt guide for agents

- "Build the ticket card, awaiting variant, with before/after tiles, following DESIGN.md and reference/tower.html."
- Quick reference: canvas `#FAFAFA`, card `#FFFFFF` with `0 0 0 1px rgba(0,0,0,0.08)`, text `#171717`, muted `#666666`, hairline `#EAEAEA`, ink `#171717`, awaiting `#F5A623`, success `#16A34A`, danger `#EE0000`, stages `#0070F3` / `#7928CA` / `#0A9DB0`, Claude `#D97757`, Codex `#10A37F`. Fonts Geist and Geist Mono. No gradients.
