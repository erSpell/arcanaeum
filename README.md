# Arcanaeum

An old-library browser for a TTRPG collection. Points at a folder of game
folders, renders each game's main sourcebook cover, and opens anything inside in
its default Windows program.

Default library root: your Windows Documents folder at `Documents\RPGs\RPG Folder`.
Change it with **Change folder** in the top rail.

## Run it

```bash
npm start
```

Or double-click `Arcanaeum.bat`, which installs dependencies on first run.

## How it works

**`main.js` (backend)** — scans the root, treats every top-level folder as one
game, walks it into a nested tree, and picks each game's cover source. Files are
launched with `shell.openPath`, so Windows file associations decide which
program opens what. Local files reach the renderer over a `biblio-img://`
protocol handler that implements real HTTP Range support — pdf.js needs it, or
it would download an entire 400MB core book just to rasterise one page.

**`src/renderer.js` (frontend)** — draws the shelves, rasterises covers with
pdf.js on a lazy `IntersectionObserver` queue (3 at a time, only for books
scrolled into view), and hands the PNG back to the backend to cache in
`%APPDATA%\arcanaeum\covers\`.

## Startup: what makes it fast

Two caches in `%APPDATA%\arcanaeum\`, both regenerable — delete
either and the app rebuilds it.

**`library-index.json`** — the scanned library, trees included.
On launch it is read and painted *before* the filesystem is touched, then
revalidated in the background. Revalidation stats directories rather than every
file: a directory's mtime changes whenever anything is added, removed, or
renamed inside it, which is everything that could change a listing. Only games
that fail that check get re-walked and pushed to the frontend.

| | cost |
|---|---|
| read + parse the index | 15 ms |
| revalidate 1,203 directories | 58 ms |
| full walk of every file (what it used to do every launch) | slower, especially cold |

**`covers/`** — one PNG per game. Never re-rendered once written.

The frontend matters as much as the caching here: the grid is built once and
mutated in place, and sorting/filtering are expressed with CSS `order` and
`hidden` so no card ever moves in the DOM. The earlier version rebuilt the whole
grid on every repaint, which destroyed and recreated all 511 `<img>` elements
and made them all re-fetch — that was what looked like the covers reloading.

**Rescan** ignores the index and re-walks everything from scratch. You only need
it if a file changed *in place* without its folder changing (rare), or if the
cover heuristic should be re-run.

### Picking the main sourcebook

No cover images exist in the library, so the cover is page 1 of whichever PDF
looks most like the core book. `pickMainBook()` in `main.js:151` scores each PDF:

| Signal | Weight |
|---|---|
| name matches *corebook / rulebook / core rules / compendium* | +100 |
| name matches *sheet / screen / playbook / adventure / errata / …* | −90 |
| filename is basically the game's name | +70 (+30 if merely contained) |
| lives in a folder called `Core` | +45 |
| file size, normalised against the biggest PDF in the game | +0–35 |
| depth below the game folder | −6 per level |

Games with no PDF fall back to their largest image; games with neither get a
title-plate placeholder.

Many PDFs open on a blank or half-title page, so after rendering, the frontend
measures ink coverage and walks up to two pages forward if page 1 is nearly
empty, keeping whichever page is busiest.

**Wrong guess?** Right-click any book → **Set cover…** to choose a different PDF
(and page) or any image on disk. The choice persists in
`%APPDATA%\arcanaeum\library-config.json`. **Re-render cover**
clears the cached PNG and redraws.

## Frontend

`src/renderer.js` + `src/styles.css` are the **Claude Design frontend**, ported
onto this backend from the original design handoff.
The port kept the design verbatim except for these spots:

1. `buildCover()` runs the real pdf.js pipeline instead of the design's mock
   `_renderMockCover` — the one place the brief flagged for the real backend.
2. `chooseCover()` prompts for a PDF page (the design hard-coded page 1).
3. **Favourites & Recently-opened** were added on top (the design left them out
   as optional): a view segmented control (**All / Favourites / Recent**) in the
   rail, a star on each book, favourite toggles in the ledger and context menu,
   and `state.favorites` / `state.recentGames` persisted via the backend.
4. **Bugfix:** added `.book[hidden]{display:none}` to the CSS. The design used
   the `hidden` attribute for filtering but its `.book{display:flex}` overrode
   the attribute's default `display:none`, so hidden cards leaked through — this
   broke both search and the new views until the guard was added.

`main.js` gained `toggle-favorite` / `note-opened` IPC handlers and a
`recentGames` config field; `preload.js` exposes `toggleFavorite` / `noteOpened`.
The original placeholder skin is kept beside the live files as
`src/renderer.placeholder.js.bak` / `src/styles.placeholder.css.bak`.

**Favourites** are starred by hovering a book's star, or via the ledger/right-
click menu; the **Favourites** tab shows only those. **Recently-opened** records
a game whenever you open its ledger (or launch its main book from the menu); the
**Recent** tab lists them newest-first, so the sort control is inert there. Both
persist in `%APPDATA%\arcanaeum\library-config.json`.

**Metadata tags** — add/remove from a book's ledger; typing in the search box
matches titles *and* tags, and `#tag` narrows to tags only. The **Tags ▾** rail
dropdown lists every tag in use with a checkbox per tag — unchecking one hides
its books for the rest of the session (resets on relaunch). Tags persist in
`config.tags` (gameId → array of strings).

**Shelf-size slider** in the rail sets `--card-min`, the grid's minimum column
width, so dragging it shows fewer/bigger or more/smaller books per row. Persists
as `config.cardSize`.

**Cover magnifier** — hovering the small cover thumbnail in a book's ledger pops
up a much larger version of the same cached PNG (already ~420px wide, so this is
real detail, not an upscale) beside it.

**Theme switcher** (**Theme ▾** in the rail) — four palettes, all defined as
`[data-theme="…"]` overrides of the same CSS custom properties in `styles.css`,
so switching never touches structural CSS, only color tokens. The three
non-default palettes were sourced from real published color-palette references
(cited as comments above each `[data-theme]` block in `styles.css`), then
chosen from a 9-option shortlist:
- **The Archive** (default) — walnut, brass, oxblood
- **Hunter & Umber** (`data-theme="hollow"`) — a hunting lodge in the woods:
  chocolate wood, hunter-green moss, warm candlelight
- **Forge Fire** (`data-theme="hearth"`) — a blacksmith's forge: charcoal
  stone, a hot red-orange fire that fills the room
- **High Noon** (`data-theme="harvest"`) — midday over the fields: vivid
  goldenrod under a crisp, clear sky-blue (interpreted as a warm gold base with
  a blue accent, rather than a literal light-mode background — the gilt-sheen/
  glow effects and dark plate mats are built to read against a dark surround,
  so a true bright theme would need a separate set of effects, not just
  different token values)

Persists as `config.theme`. Adding a fifth theme means adding one more
`:root[data-theme="…"]{…}` block — see the token list at the top of `styles.css`.

**Re-running the design later:** drop the new `.dc.html` into
`design_handoff_library_of_rutesia/`, then re-apply those two edits to its
second `<script>` and copy it into `src/renderer.js` + `src/styles.css`. The
`window.lib` contract the design targets is documented in that folder's README.

## Layout

```
main.js                                backend: scan, cover picking, launching, config
preload.js                             the window.lib bridge
scripts/vendor-pdfjs.js                copies pdf.js into src/ (CSP is script-src 'self')
src/index.html                         shell + CSP
src/renderer.js                        frontend (ported Claude Design) + the cover pipeline
src/styles.css                         frontend styling + the theme token system
src/*.placeholder.*.bak                the original placeholder skin, kept for reference
design_handoff_library_of_rutesia/     the Claude Design deliverable (.dc.html) + its README
```

## Keyboard

- `/` — focus search
- `Esc` — close the ledger pop-up or the context menu
