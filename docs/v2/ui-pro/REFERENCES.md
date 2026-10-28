# Cleared v2: the references of the professional redesign

Lane `v2-j6-ui-pro`, issue #461. The owner turned down the Signal theme of #460 as not professional and named six tools to learn from. Each one was read on 2026-10-28 from its public 2026 sources (changelogs, documentation, a dated review with a screenshot); the signed-in apps themselves (app.devin.ai, the Codex web app, a Vercel team) were not opened, since they need an account, so what is said of them comes from those sources. No image of theirs is in the repository, and no page of theirs is copied. Each section says what the source states, then what Cleared takes from it; a choice the sources do not state is marked as Cleared's own. The table at the end is the direction of [DESIGN.md](DESIGN.md).

## Devin (Cognition)

Sources: [Devin Desktop changelog](https://docs.devin.ai/desktop/changelog?type=next) (entries of 2026-04-15 to 2026-10-26; on 2026-10-23 its agent window was made to match the Devin web app's look, so it stands for the web app here); the release trackers' digest of [2026-09-30](https://www.havoptic.com/r/devin-2026-09-30) and [2026-10-02](https://www.havoptic.com/r/devin-2026-10-02).

- **Layout.** A sessions sidebar grouped by status (2026-09-25: Working, Ready, Blocked, Inactive), sticky group heads (2026-07-29), a bell for the sessions' notifications in the sidebar. The sidebar names the approval a session waits on, in words, not a colour alone.
- **Density.** A session's detail (status, last lines, pull requests) in a hover card rather than in the row; read-only sessions greyed out rather than hidden.
- **Type.** Inter by default in the agent window, web-app icon sizes (2026-07-29); the interface and code fonts chosen apart (2026-10-23).
- **Colour.** Status shown by a small state icon (open, draft, merged, closed), not by a coloured block.
- **What we take.** Cleared's sidebar groups (Pour vous, Au travail, En relecture) stay, set as Devin sets them: a quiet group head with its count, compact rows, the state said in words. The approval waiting is the one row that may carry the amber mark.

## OpenAI Codex (web and app)

Sources: [Codex web, OpenAI's documentation](https://learn.chatgpt.com/docs/cloud) (2026); [Introducing the Codex app](https://simonwillison.net/2026/feb/2/introducing-the-codex-app), 2026-02-02, with its screenshot; [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/), 2026-04-16.

- **Layout.** A sidebar of threads grouped under their project, each with its age (2h, 18h, 1d) at the right; a main pane with the thread's title and its project in a thin top bar, two actions at the right of that bar; the composer at the foot with the environment and the branch beside it.
- **Density.** Rows carry a title and an age, nothing else; the detail lives in the pane.
- **What we take.** The top bar thin, holding the screen's title (or crumb) and at most its actions; ages and figures right-aligned in tabular digits. Cleared's own choice, not stated by the sources: the branch, the ticket id and the model in Geist Mono, colour only on the one action.

## Linear

Sources: [UI refresh, Linear changelog, 2026-03-12](https://linear.app/changelog/2026-03-12-ui-refresh); [Linear's changelog timeline](https://linear.app/changelog/timeline) (the mobile navigation entry of 2026-01-22).

- **Layout.** Headers, navigation and view controls the same on every screen; the navigation sidebar "slightly dimmer" so the main area stands out.
- **Icons and borders.** Icons redrawn and resized; reviews of the refresh add that tab bars were compacted, icons made slightly smaller and a few borders removed.
- **Tone.** "A calmer, more consistent interface", made to be scanned.
- **What we take.** The sidebar on a ground one step greyer than the page; every screen's head built the same way; fewer lines, one where two regions meet. Cleared's own choices in the same spirit: the current item a light grey fill (not an ink plate), list groups as thin heads with a count, rows at 36 to 44 px, weights 500 and 600, icons at 16 px.

## Cursor

Sources: [Cursor 3.0 changelog](https://cursor.com/changelog/3-0), 2026-04-02.

- **Layout.** The Agents Window: many agents in parallel across repositories and environments, "centered around agents, while keeping the depth of a development environment"; chats side by side or in a grid; the tab bar spans the full width in a maximised chat layout.
- **What we take.** The session screen's tabs (Plan, Terminal, Editor, Browser) as one tab bar across the thread's panel. Cleared's own choice: an underline marks the current tab, and a path, a diff and a command sit in mono on a light grey well, never on an ink block.

## Vercel dashboard and Geist

Sources: [dashboard navigation redesign rollout](https://vercel.com/changelog/dashboard-navigation-redesign-rollout), 2026-02-26; [Geist materials](https://vercel.com/geist/materials) and [Geist typography](https://vercel.com/geist/typography) (current in 2026).

- **Layout.** Horizontal tabs moved into a resizable sidebar that can be hidden; on a phone, a bottom bar for one hand.
- **Radii.** Surfaces at 6 px (base, small), menus and dialogs at 12 px, tooltips at 6 px.
- **Type.** Geist Sans and Geist Mono; label sizes 12, 13, 14 px and up, copy sizes 13, 14 px and up, heading sizes from 14 px.
- **Materials.** "Presets for radii, fills, strokes, and shadows"; the tooltip has the lightest shadow, a menu and a modal lift further.
- **What we take.** Geist itself (already the app's self-hosted face, matrix B3.8, and an equivalent of Inter); the sizes 12, 13 and 14 px for labels and copy; radii 6 px on controls; the phone's bottom bar kept. Cleared's own choices: 8 px rather than 12 on menus and dialogs, to stay quiet, and no shadow at all, since the CI guard of #460 refuses a blurred one.

## Raycast

Sources: [Raycast for macOS v0.51](https://www.raycast.com/changelog/macos-beta/0-51), 2026-03-27 (the new app, "a new refreshed look and feel", "a new, simplified compact mode"); [v0.66](https://www.raycast.com/changelog/macos/0-66), 2026-06-24 (interface size).

- **Look.** A refreshed look across the app and "a new, simplified compact mode design" (v0.51); the interface scaled to one of three sizes, text, buttons and fields with it (v0.66).
- **What we take.** The sizes in rem, so the browser's own size scales the app as Raycast's setting does. Cleared's own choice in the spirit of its compact mode: the palette (`Ctrl K`) a white dialog with a 1 px line and an 8 px radius, its selected row a light grey fill, its keys small bordered caps.

## What the six agree on, and what Cleared takes

| Topic | The references | Cleared |
| --- | --- | --- |
| Ground | the sidebar dimmer than the main area (Linear) | page `#FFFFFF`, sidebar `#F7F7F8` |
| Borders | fewer borders (Linear 2026) | 1 px `#E6E6E7`; the 2 px ink frames of #460 removed; fields `#8D8E90` at 3:1 |
| Radii | 6 px surfaces, 12 px floating (Vercel) | 6 px controls and rows, 8 px panels, menus and dialogs |
| Shadow | none on surfaces; the lightest on what floats | none: the CI guard refuses a blurred shadow, so a menu has a border |
| Type | Inter (Devin), Geist 12 to 14 px labels and copy (Vercel) | Geist 12, 13, 14, 16, 20 px; weights 400, 500, 600 |
| Mono | Geist Mono beside Geist Sans (Vercel) | Geist Mono for ids, branches, paths, commands, unchanged rule |
| Colour | "calmer" (Linear) | one indigo accent; amber, green, red, teal as small marks only |
| Status | a state icon, the approval named in words (Devin) | a 6 px dot beside its word; the count of what waits a pale amber pill |
| Navigation | sidebar grouped by status (Devin), a sidebar that hides, a bottom bar on a phone (Vercel) | the sidebar's session groups and the phone's bar kept; the current item a grey fill, not an ink plate |
