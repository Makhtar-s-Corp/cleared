# Cleared v2: Signal, the Hallmark redesign of the web app

**Superseded** by [docs/v2/ui-pro/DESIGN.md](../ui-pro/DESIGN.md) (lane `v2-j6-ui-pro`, issue #461): the owner turned Signal down as not professional. This file is kept as the record of #460.

Lane `v2-j6-ui-hallmark`, issue #451. This file is the locked system of the v2 web app (`v2/app/web`): every sheet reads its tokens from `styles/app.css`, and every rule below is checked by a test where a test can check it.

## The theme and why

**Signal, a custom Hallmark theme.** Hallmark dealt three themes for this prompt (Console, Blueprint, Lumen) and all three sit on a dark or mid ground, which the owner's light-only rule refuses, so the run is custom: it takes the material of Hallmark's Wayfind theme (public signage: square 2px ink borders, ink plates that carry one figure, cobalt for what is live, amber for figures) and sets it on a light, cool paper. The faces stay Geist and Geist Mono, the project's own self-hosted files (matrix line B3.8), cut heavy for headings and figures, because Wayfind's all-mono face would make the long French business text slow to read.

What a person should feel at first glance: a control room board read in daylight. Each screen leads with one large heading and, where the screen has one, its one figure on an ink plate; lists are departure boards with an ink head rule; the one primary action is the cobalt button.

## Palette

Every colour is a token on `:root` in `styles/app.css`. The neutrals are mixed from two colours (`--theme-contrast` into `--theme-base`), so the greys stay one family.

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Base | `--theme-base` | `#FFFFFF` | surfaces, fields, cards' insides |
| Ink | `--theme-contrast` | `#0E1726` | text, 2px frames, ink plates, the current place |
| Cobalt | `--theme-accent` | `#1F45D6` | the primary action, links, what is live (in progress) |
| Paper | `--canvas` | ink 6.5 % into base | the page's ground |
| Paper 2 | `--sidebar` | ink 11 % into base | the sidebar, bands, a sunken well |
| Amber | `--awaiting` | `#F2B33D` | what waits for the person: a fill under ink text, a figure on ink |
| Amber text | `--awaiting-text` | `#8A4500` | amber said as text on paper |
| Green | `--success` / `--success-text` | `#12823B` | done, passed |
| Red | `--danger` / `--danger-text` | `#C3122B` | failed, refused, a limit reached |
| Teal | `--stage-review` | `#07778A` | in review |

Rules:

- **Light only.** There is no dark theme, no `data-theme="dark"`, no `prefers-color-scheme` block and no theme button. The page never follows the system's scheme.
- **Flat.** No gradient anywhere in `v2/app/web` (CI: `app/test/redesign/flat.test.ts`, the step "Flat colours guard"). No blurred shadow: depth is a 2px ink frame or a 1px rule. No `backdrop-filter`, no `filter: blur`.
- **No translucent chips.** An information element (a tag, a count, a state) is an opaque fill or an opaque frame, never white or ink at partial opacity. The one translucent colour is the scrim behind a dialog.
- **Amber** never sets body text on paper; on paper it is `--awaiting-text`. Amber as a fill always carries ink text.
- **Cobalt** marks the primary action and what is live; nothing decorative is cobalt.

## Type

- **Faces:** Geist (`--sans`) for everything; Geist Mono (`--mono`) for ids, commands and code only. Both are self-hosted in `v2/app/public/fonts`. Nothing loads from another site.
- **Scale** (rem, so the person's own size scales it): `--text-sm` 0.8125rem (13 px), `--text-md` 0.875rem (14 px), `--text-lg` 1.25rem (20 px), `--text-xl` 1.75rem (28 px), `--text-display` 2.5rem (40 px). `--text-input` 1rem on a phone's fields.
- **Weights:** `--weight-regular` 400, `--weight-strong` 600, `--weight-heavy` 800. Headings and figures are heavy with a tight negative tracking; labels are the body face a step smaller, sentence case, never tracked wider, never in capitals.
- **Numbers:** `font-variant-numeric: tabular-nums` on the body, so every figure aligns; figures in a table align right.

## Spacing, radii, frames

- **Spacing:** `--space-1` 4px, `--space-2` 8px, `--space-3` 16px, `--space-4` 24px, `--space-5` 32px, `--space-6` 48px.
- **Radii:** `--radius` 0 for surfaces, fields and buttons. Only dots, counts and the progress bars' ends are round.
- **Frames:** `--frame` 2px ink around a surface that holds a task (a panel, a dialog, a menu, a field, a secondary button); `--rule` 1px `--hairline` between rows; a 2px ink rule under a list's head.

## States

| State | Rule |
| --- | --- |
| Hover | the ground changes (`--tab-fill`, or the cobalt goes one step darker); nothing moves, nothing scales |
| Press (`:active`) | the ground goes one step darker again; nothing moves |
| Focus | a 3px cobalt outline, 2px off the element, instant, kept by forced colours |
| Current | an ink plate: ink ground, paper text |
| Disabled | `--text-faint` text on `--surface-muted`, `cursor: default`, no opacity on information |
| Error | `--danger-text` and a 2px `--danger` frame on the field; the message says what to do |
| Loading | a skeleton in the shape of what comes (`.skeleton`), the words kept for a screen reader, `aria-busy` on the region |

## Motion and access

- Only `opacity` and `transform` transition, at `--motion` (140 ms); nothing animates on a press or a hover of a clickable element; `prefers-reduced-motion: reduce` sets `--motion` to 0.
- Decorations take `pointer-events: none`.
- Targets are 44 px under a coarse pointer and on a phone; a smaller visual box gets a 44 px hit area.
- Every text colour reads at 4.5:1 on every ground it is drawn on (`app/test/shell/tokens.test.ts`).

## Copy

No em dash anywhere, no exclamation mark, no emoji, sentence case. A meta line is laid out in columns or cells, never joined by middle dots in the markup. Every new string is in both catalogs, French and English.
