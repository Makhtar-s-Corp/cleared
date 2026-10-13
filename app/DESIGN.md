---
name: Cleared Cockpit
version: 0.2.0
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
  text-faint: "#8F8F8F"
  ink: "#171717"
  on-ink: "#FFFFFF"
  awaiting: "#F5A623"
  awaiting-text: "#AB570A"
  awaiting-surface: "#FFFBF2"
  awaiting-highlight: "#FCE2B3"
  success: "#16A34A"
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
    label-mono: { size: 12, weight: 500, tracking: 0.04em, transform: uppercase, family: mono }
    stat: { size: 28, weight: 600, tracking: -0.03em }
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

Reference mockups: `reference/tower.html` (desktop tower) and `reference/porthole-phone.html` (porthole on a phone). Open them in a browser and match them. When this file and the mockups disagree, this file wins.

## 1. Visual theme and atmosphere

Light, precise, calm. A developer tool in the spirit of Vercel's dashboard: near-white canvas, white cards outlined by a one-pixel shadow instead of a border, black for actions, grey for everything that does not ask for attention. The interface disappears; the work shows.

One rule above all: **amber is reserved for what waits for the human.** An approval, a question. If amber appears anywhere else, nothing stands out any more.

**No gradients, anywhere.** Not on text, not on backgrounds, not on borders, not on avatars, not on progress bars, not as patterns. Every color is flat. Progress that is partly done is a filled bar inside an empty bar, not a two-stop gradient.

Light is the primary theme. A dark theme may come later; it will follow the same roles, never the same values.

## 2. Color roles

- **Ink** (`ink`): the only fill for primary actions and strong chips ("Ready to land", the main button), and the logo.
- **Awaiting** (`awaiting`): the 3 px top stripe and the glow of a card that waits for the human, the column marker of "Awaiting you", the highlighter under the key words of the greeting (`awaiting-highlight`). Text on amber backgrounds uses `awaiting-text` for contrast. A question card sits on `awaiting-surface`.
- **Stages**: each column has a dot and its segment of the progress rail in its stage color. In progress `stage-progress`, Checks `stage-checks`, Review `stage-review`, Awaiting you `awaiting`. Nowhere else.
- **Harness**: a small square in the harness color before the model name, and the fuel bar of that subscription. Claude `harness-claude`, Codex `harness-codex`, others `harness-other`. Never used for a state.
- **State**: `success` for green checks, a clean release, healthy, the "after" side of a before/after; `danger` for a rollback, a failure, a negative figure in a "before". Never both on the same card except in a before/after pair.
- **Text**: `text` for titles and values, `text-secondary` for body on cards, `text-muted` for labels, `text-faint` for ticket ids and times.

## 3. Typography

- Geist for words, Geist Mono for every number, duration, time, model name, ticket id and percentage.
- Titles use tight negative tracking (display -0.045em, title -0.035em). Never positive tracking except on mono labels.
- Column names and section labels are Geist Mono, uppercase, 12 px, slightly spaced (`label-mono`). Everything else is sentence case.
- Ticket titles are the most important text of a card. Never truncated on desktop; up to three lines.
- One display line per screen: the greeting on the tower.

## 4. Components

### Header
White, `elevation.header`. Left: logo (black triangle), product name, a slash, the project switcher (flat amber dot, project name, chevron). Centre-left: view tabs (Tower, Landed, Fuel, Rules), active tab on a 5% black fill. Right: health pill (white, outlined, green dot and "All systems normal", or danger dot and the problem in plain words), local time in mono, avatar (black circle, white initial).

### Greeting band
Mono date line in `text-faint` uppercase. Then the display line: "Good morning, Alex." and on the next line the state in two tones: the first words in `text-faint`, the key words in `text` with an `awaiting-highlight` underline at 0.32em thickness. When nothing waits: "Nothing needs you." with no highlight.

### Stat strip
One white outlined block with hairline separators: In flight, Landed today, First-time clean, and Fuel left this week (one 6 px bar per subscription in its harness color, with the percentage left in mono). Never a currency.

### Ticket card
- White, radius `card`, `elevation.card`, padding 16.
- Top row: ticket id in mono `text-faint`; on the right, a state hint (blue live dot and "Building", a test counter in the stage color, "Round 2 of 2").
- Title, `card-title`.
- Progress rail: four 4 px segments, gap 3 px, filled in their stage color as the ticket moves; a running stage shows a partial fill as an inner bar.
- Meta row: harness square and exact model in mono, flight time in mono, share of the week's usage on the right in mono.
- Status sentence below a hairline, `text-secondary`.

**Awaiting, ready to land:** same white card, 3 px flat `awaiting` stripe on top, `elevation.awaiting`, a black "Ready to land" chip. If the ticket touches a screen, two small before/after tiles: before on `canvas` with the key figure in `danger` when it is a problem, after on `success-surface` with a `success` outline.

**Awaiting, question:** `awaiting-surface` background, amber outline, an outlined "Question" chip in `awaiting-text`, the question as the title, one sentence with the concrete example and the squad's recommendation.

**Queued** (waiting for a machine slot): `surface-muted`, 1 px dashed border `#D4D4D4`, no shadow, title in `text-secondary`, one sentence with the reason.

### Live dot
6 px circle in `stage-progress` with a 3 px halo at 15% opacity, slow pulse. Only on a squad actually running. Stops with reduced motion.

### Landed today
White outlined table at the bottom of the tower: time (mono), what shipped (plain title), model (mono), outcome with a small dot ("Clean first time" and "One review round" in `success`, "Rolled back 11:49" in `danger`). A "View all" link on the right of its header.

### Porthole
Desktop: right panel. Phone: full page with a back button, the ticket id and the status chip in a white header.
Order: a 3 px × 56 px flat amber bar above the title when it waits for the human, the title (`title`), a stat strip (flight, fuel, tests), Show me, Where we are, The squad, Black box.
- Show me, screen ticket: before and after inside device frames (radius `device`, 5 px white bezel, outline), after with `elevation.device-after`.
- Show me, non-screen ticket: one concrete before/after example, the tests with their state, one sentence on what it touches. The diff is only a link.
- The squad: one white outlined list, a row per role (harness square, role, harness and exact model in mono).
- Black box: vertical timeline on a hairline, one dot per event in its stage color, time in mono, one plain sentence.
- Future actions (Clear to land, Send back) appear as disabled placeholders labelled "soon". Nothing pretends to act.

## 5. Layout

- Desktop: header, greeting band with the stat strip on the right, four-column board, Landed today. Side margins 32 px, column gap 16 px, card gap 10 px.
- Cards awaiting the human are always first in their column.
- Phone: one column. Awaiting cards first, then the rest by stage. Header keeps health; the stat strip wraps to two rows.
- An empty column says so in one `text-faint` line. No illustrations, no decoration.

## 6. Depth

Three levels: canvas, card (one-pixel shadow outline plus a 2 px soft shadow), awaiting card (amber outline plus an amber soft shadow). No other shadows. Borders are shadows or hairlines, never thick.

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
