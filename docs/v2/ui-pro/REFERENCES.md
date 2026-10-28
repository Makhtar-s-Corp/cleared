# Cleared v2: the references of the professional redesign

Lane `v2-j6-ui-pro`, issue #461. The owner turned down the Signal theme of #460 as not professional and named six tools to learn from. Each one was read on 2026-10-28 from its 2026 sources (changelogs, documentation, a dated review); no image of theirs is in the repository, and no page of theirs is copied. What each brings is below, then what the six agree on, which is the direction of [DESIGN.md](DESIGN.md).

## Devin (Cognition)

Sources: [Devin Desktop changelog](https://docs.devin.ai/desktop/changelog?type=next) (entries of 2026-04-15 to 2026-10-26); the release trackers' digest of [2026-09-30](https://www.havoptic.com/r/devin-2026-09-30) and [2026-10-02](https://www.havoptic.com/r/devin-2026-10-02).

- **Layout.** A sessions sidebar grouped by status (2026-09-25: Working, Ready, Blocked, Inactive), sticky group heads (2026-07-29), a bell for the sessions' notifications in the sidebar. The sidebar names the approval a session waits on, in words, not a colour alone.
- **Density.** One line per session in the sidebar, the detail on hover; read-only sessions greyed out rather than hidden.
- **Type.** Inter by default in the agent window, web-app icon sizes (2026-07-29); the interface and code fonts chosen apart (2026-10-23).
- **Colour.** Status shown by a small state icon (open, draft, merged, closed), not by a coloured block.
- **What we take.** Cleared's sidebar groups (Pour vous, Au travail, En relecture) stay, set as Devin sets them: a quiet group head with its count, compact rows, the state said in words. The approval waiting is the one row that may carry the amber mark.

## OpenAI Codex (web and app)

Sources: [Codex web, OpenAI's documentation](https://learn.chatgpt.com/docs/cloud) (2026); [Introducing the Codex app](https://simonwillison.net/2026/feb/2/introducing-the-codex-app), 2026-02-02, with its screenshot; [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/), 2026-04-16.

- **Layout.** A sidebar of threads grouped under their project, each with its age (2h, 18h, 1d) at the right; a main pane with the thread's title and its project in a thin top bar, two actions at the right of that bar; the composer at the foot with the environment and the branch beside it.
- **Density.** Rows carry a title and an age, nothing else; the detail lives in the pane.
- **Type.** System sans for the interface; the branch and the environment in monospace.
- **Colour.** Neutral greys; colour only on the one action and on a diff's lines.
- **What we take.** The top bar thin, holding the screen's title (or crumb) and at most its actions; ages and figures right-aligned in tabular digits; the branch, the ticket id and the model in Geist Mono.

## Linear

Sources: [UI refresh, Linear changelog, 2026-03-12](https://linear.app/changelog/2026-03-12-ui-refresh); [mobile navigation, 2026-01-22](https://linear-web.pages.dev/changelog/2026-01-22-customize-your-navigation-in-linear-mobile).

- **Layout.** Headers, navigation and view controls the same on every screen; the navigation sidebar "slightly dimmer" so the main area stands out; tab bars compacted.
- **Density.** Rows of a list at about 36 to 40 px, a list's groups as thin heads with a count.
- **Borders.** A few borders removed in 2026: one hairline where two regions meet, no frame inside a frame.
- **Type.** Icons redrawn smaller; text in one sans, hierarchy by weight 500 and 600 and a step of size, never by a display face.
- **Colour.** "A calmer, more consistent interface": grey on grey, the accent on the current selection and the primary button only.
- **What we take.** The sidebar on a ground one step darker than the page, the current item a light grey fill (not an ink plate); every screen's head built the same way; list groups as thin heads with a count; icons at 16 px with a thin stroke.

## Cursor

Sources: [Cursor 3.0 changelog](https://cursor.com/changelog/3-0), 2026-04-02; [Cursor 3 review, DataCamp](https://www.datacamp.com/blog/cursor-3), 2026-04.

- **Layout.** The Agents Window: many agents across repositories in one pane, each a tab or a row, the editor kept for the detail; the tab bar spans the width.
- **Density.** Agent rows at one line with their state; tabs compact.
- **Type.** Sans for the interface, mono for paths and diffs.
- **What we take.** The session screen's tabs (Plan, Editor, Terminal) as a compact underline tab bar; a path, a diff and a command in mono on a light grey well, never on an ink block.

## Vercel dashboard and Geist

Sources: [dashboard navigation redesign rollout](https://vercel.com/changelog/dashboard-navigation-redesign-rollout), 2026-02-26; [Geist materials](https://vercel.com/geist/materials) and [Geist typography](https://vercel.com/geist/typography) (current in 2026).

- **Layout.** Horizontal tabs moved into a resizable sidebar that can be hidden; on a phone, a bottom bar for one hand.
- **Radii.** Surfaces at 6 px (base, small), menus and dialogs at 12 px, tooltips at 6 px.
- **Type.** Geist Sans and Geist Mono; labels at 12, 13 and 14 px, copy at 13 and 14 px; headings from 14 px up, the app's own screens rarely past 24 px.
- **Borders and shadows.** A 1 px stroke on surfaces; shadow kept for what floats, and the lightest one on a tooltip.
- **What we take.** Geist itself (already the app's self-hosted face, matrix B3.8), the label and copy sizes 12 and 13 px with 14 for the body of long French text, radii 6 px on controls and 8 px on surfaces; the phone's bottom bar kept.

## Raycast

Sources: [Raycast for macOS v0.51](https://www.raycast.com/changelog/macos-beta/0-51), 2026-03-27 (the new app, "a new refreshed look and feel", "a new, simplified compact mode"); [v0.66](https://www.raycast.com/changelog/macos/0-66), 2026-06-24 (interface size).

- **Layout.** The command palette as the centre of the tool: one field, grouped results, a footer of keys.
- **Density.** A compact mode as the default reading of a list; the interface size the person's own (Cleared's sizes are in rem for that reason).
- **What we take.** The palette (`Ctrl K`) as a white dialog with a 1 px border and an 8 px radius, its selected row a light grey fill, its keys as small bordered caps; the sizes in rem so the browser's size scales the app.

## What the six agree on, and what Cleared takes

| Topic | The references | Cleared |
| --- | --- | --- |
| Ground | white main area, the sidebar a step greyer (Linear, Vercel, Codex) | page `#FFFFFF`, sidebar `#F7F8F9` |
| Borders | one 1 px hairline where regions meet, no frame in a frame (Linear 2026) | 1 px `#E4E6EA`; the 2 px ink frames of #460 removed |
| Radii | 6 px controls, 8 to 12 px floating (Vercel) | 6 px controls and rows, 8 px panels, menus and dialogs |
| Shadow | none on surfaces; the lightest on what floats | none: the CI guard refuses a blurred shadow, so a menu has a border |
| Type | Inter or Geist, 12 to 14 px, headings 14 to 20 px, weights 500 and 600 | Geist 12, 13, 14, 16, 20 px; weights 400, 500, 600 |
| Mono | ids, branches, paths, commands | Geist Mono, unchanged rule |
| Colour | grey, one accent on the primary action and the selection | one indigo accent; amber, green, red, blue as small marks only |
| Status | an icon or a dot with a word (Devin, Linear) | a 6 px dot beside its word; the count of what waits a quiet grey pill |
| Navigation | sidebar grouped, current item a grey fill; bottom bar on a phone (Vercel) | the same; the ink plate goes |
