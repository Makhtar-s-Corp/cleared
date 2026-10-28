# Cleared v2: Workbench, the professional look of the web app

Lane `v2-j6-ui-pro`, issue #461. This file is the locked system of the v2 web app (`v2/app/web`); it replaces [the Signal theme](../ui-hallmark/DESIGN.md) of #460, which the owner turned down as not professional. Every sheet reads its tokens from `styles/app.css`, and every rule below that a test can check is checked. The references behind it are in [REFERENCES.md](REFERENCES.md).

## Direction

A calm, dense engineering tool on white: soft grey lines, one indigo accent for the primary action and the selection, and status said by a small dot beside its word. The hierarchy comes from size and weight in one sans, never from colour blocks, ink frames or display type.

## Palette

Every colour is a token on `:root` in `styles/app.css`. The greys are mixed from two colours (`--theme-contrast` into `--theme-base`), so they stay one family; the values below are what the mixes give.

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Base | `--theme-base` | `#FFFFFF` | the page, panels, fields, menus, dialogs |
| Contrast | `--theme-contrast` | `#1A1C21` | text, a tooltip's ground |
| Accent | `--theme-accent` | `#4C5BD4` | the primary button, links, the focus ring, what is live; 5.6:1 under white text |
| Sidebar | `--sidebar` | 3.5 % (`#F7F7F8`) | the sidebar, the sign-in page's ground |
| Sunken | `--sunken` | 4 % (`#F6F6F6`) | wells: code, commands, notes |
| Hover | `--tab-fill` | 5.5 % (`#F2F2F3`) | a row or a button under the pointer |
| Selected | `--selected` | 8 % (`#EDEDEE`) | the current place, the pressed state, a picked row |
| Line | `--line` (`--hairline`) | 11 % (`#E6E6E7`) | every border and divider |
| Field line | `--input` | 50 % (`#8D8E90`) | a field's border, 3:1 against its ground (WCAG 1.4.11) |
| Button line | `--outline` | 20 % (`#D1D2D3`) | a secondary button's border |
| Secondary text | `--text-secondary` | 80 % | body copy under a title |
| Muted text | `--text-muted` | 70 % | meta, counts, labels |
| Faint text | `--text-faint` | 66 % | disabled text; 4.6:1 on the darkest grey |
| Waiting | `--awaiting`, `--awaiting-text` | `#E8A33D`, `#8A4500` | a dot, the count's tint, the word on white |
| Success | `--success`, `--success-text` | `#1F8A4C`, `#17703D` | a dot, a passed check |
| Error | `--danger`, `--danger-text` | `#D1293D`, `#B4192C` | a dot, an error line, a quota reached |
| In review | `--stage-review` | `#0B7A8A` | a dot |

Rules:

- **Light only.** No dark theme, no `prefers-color-scheme`, no theme button (CI: `app/test/redesign/flat.test.ts`, step "Flat colours guard").
- **Flat.** No gradient, no blurred shadow, no `backdrop-filter`. Depth is a 1px line (`--e-card`, `--e-menu`, `--e-control` are 0-blur 1px rings) or a step of grey. The only translucent colour is the dialog's scrim.
- **One accent.** Indigo marks the primary action, a link, the focus ring and what is live, nothing decorative. A screen has at most one indigo button.
- **Status is a mark, not a block.** A 6 px dot beside its word; a tint (`--awaiting-surface`, `--danger-fill`) only behind a short line that must be read (an error, a fresh secret).

## Type

- **Faces:** Geist (`--sans`), the Inter-like grotesque the app already self-hosts (matrix B3.8), for everything; Geist Mono (`--mono`) for ids, hashes, branches, paths and commands only. Both in `v2/app/public/fonts`, nothing from another site.
- **Scale** (rem, so the person's own size scales it): `--text-sm` 12 px (meta, counts, labels), `--text-md` 13 px (body, rows, buttons), `--text-lg` 14 px (a section's or a row's title), `--text-xl` 16 px (a panel's title, the phone's screen title), `--text-display` 20 px (a screen's title, the largest type in the app). `--text-input` 16 px on a phone's fields.
- **Weights:** 400 (`--weight-regular`), 500 (`--weight-strong`: titles of rows, buttons, the current place), 600 (`--weight-heavy`: headings and figures). Never heavier.
- **Numbers:** `tabular-nums` on the body; figures in a table align right.
- **Labels** are the body face a step smaller, sentence case, never tracked wider, never in capitals.

## Spacing, radii, lines

- **Spacing:** `--space-1` 4, `--space-2` 8, `--space-3` 16, `--space-4` 24, `--space-5` 32, `--space-6` 48 px.
- **Density:** a list row 36 px (`--row`), a sidebar row 28 to 32 px, a button 28 to 32 px on a computer, 44 px under a coarse pointer and on a phone. The top bar 48 px, the sidebar 240 px.
- **Radii:** `--radius` 6 px on controls, rows and chips; `--radius-panel` 8 px on panels, menus, dialogs and empty blocks; dots and counts round.
- **Lines:** `--line` 1 px around a panel and between rows; no frame inside a frame; no 2 px border anywhere but the focus ring.

## States

| State | Rule |
| --- | --- |
| Hover | the ground steps to `--tab-fill` (a white button to `--surface-muted`; the indigo one to `--accent-hover`); nothing moves, nothing scales |
| Press (`:active`) | one step darker again (`--selected`, `--accent-press`) |
| Focus | a 2 px indigo outline, 2 px off the element, instant, kept by forced colours |
| Current | `--selected` ground, the text in `--text`, weight 500; on the phone's bar of screens, the icon and word in indigo |
| Disabled | `--text-faint` on `--surface-muted`, `cursor: default`, no opacity on information |
| Error | `--danger-text` on `--danger-fill`, or a field's line in `--danger`; the message says what to do |
| Loading | a skeleton in the shape of what comes (`.skeleton`, grey bars with a 4 px radius), the words kept for a screen reader, `aria-busy` on the region |
| Empty | what belongs here and the one action that fills it (`.empty-state`, `.empty-state.block`) |

## Motion and access

- Only `opacity` and `transform` transition, at `--motion` (140 ms); nothing animates on a hover or a press; `prefers-reduced-motion: reduce` sets `--motion` to 0.
- Decorations take `pointer-events: none`.
- Targets are 44 px under a coarse pointer and on a phone.
- Every text colour reads at 4.5:1 on every ground it is drawn on (`app/test/shell/tokens.test.ts`); axe has no error at 1440 and 390.

## Copy

No em dash, no exclamation mark, no emoji, sentence case. A meta line is laid out in cells parted by a short line (`components/facts/Facts.tsx`), never joined by middle dots. Every new string is in both catalogs, French and English.
