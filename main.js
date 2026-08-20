'use strict';

// Arcanaeum — backend.
//
// Owns: the library scan (top-level folders under the RPG root = "games"), the
// per-game file tree, picking + caching each game's cover, and handing files off
// to the OS. All view state lives in the renderer.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const DEFAULT_ROOT = path.join(app.getPath('documents'), 'RPGs', 'RPG Folder');

// Extensions we surface in the game popup, grouped for the UI. Anything not
// listed still shows up under "other" — the OS knows what to do with it.
const KIND_BY_EXT = {
  '.pdf': 'pdf',
  '.epub': 'pdf',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image',
  '.gif': 'image', '.bmp': 'image', '.svg': 'image', '.tif': 'image', '.tiff': 'image',
  '.txt': 'text', '.md': 'text', '.rtf': 'text', '.csv': 'text',
  '.doc': 'doc', '.docx': 'doc', '.odt': 'doc', '.xls': 'doc', '.xlsx': 'doc',
  '.ppt': 'doc', '.pptx': 'doc',
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio', '.m4a': 'audio',
  '.mp4': 'video', '.mkv': 'video', '.webm': 'video', '.mov': 'video', '.avi': 'video',
  '.zip': 'archive', '.7z': 'archive', '.rar': 'archive',
};

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

const MAX_TREE_DEPTH = 8;
const MAX_TREE_NODES = 4000;

// Names that mark a PDF as supporting material rather than the core book.
const SUPPLEMENT_RE = new RegExp([
  'sheet', 'screen', 'cheat', 'reference', 'playbook', 'map', 'handout', 'errata',
  'preview', 'quickstart', 'quick start', 'starter', 'primer', 'token', 'card',
  'supplement', 'adventure', 'module', 'scenario', 'appendix', 'index', 'form',
  'player.?kit', 'singles', 'spreads', 'printer', 'b&w', 'grayscale', 'greyscale',
  'errat', 'changelog', 'kickstarter', 'ashcan', 'zine', 'poster', 'insert',
  'character', 'npc', 'monster', 'bestiary', 'spell', 'item', 'gm ', 'ttrpg log',
].join('|'), 'i');

// Names that mark a PDF as the core book.
const CORE_RE = /\b(core(\s|_|-)?(rule)?book|corebook|core rules?|rule ?book|rulebook|core|main|complete|compendium|players? handbook|basic rules)\b/i;

// ---------------------------------------------------------------- state

const userDir = () => app.getPath('userData');
const configPath = () => path.join(userDir(), 'library-config.json');
const legacyConfigPath = () => path.join(userDir(), 'bibliotheca-config.json'); // pre-rename filename
const coverDir = () => path.join(userDir(), 'covers');

const DEFAULT_CONFIG = {
  root: DEFAULT_ROOT,
  sort: 'name',
  layout: 'shelf',
  filter: '',
  cardSize: 178,        // px — minimum grid-cell width, set by the shelf-size slider
  theme: 'archive',     // 'archive' | 'hollow' | 'hearth' | 'harvest' — see styles.css [data-theme]
  favorites: [],        // gameIds the user has starred
  recentGames: [],      // gameIds most-recently opened, newest first
  recents: [],          // legacy: absolute paths of launched files (unused by UI)
  tags: {},             // gameId -> array of user metadata tags
  coverOverrides: {},   // gameId -> absolute path of the pdf/image to use
  coverPages: {},       // gameId -> 1-based page number of the pdf to render
};

const RECENT_LIMIT = 60;

let config = { ...DEFAULT_CONFIG };

function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    // Fall back to the pre-rename filename so existing settings (favorites,
    // tags, theme, etc.) survive earlier app renames.
    // The next save writes the new filename; the old file is left untouched.
    try {
      const raw = fs.readFileSync(legacyConfigPath(), 'utf8');
      config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch {
      config = { ...DEFAULT_CONFIG };
    }
  }
  return config;
}

function saveConfig(partial) {
  config = { ...config, ...(partial || {}) };
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] save failed:', err.message);
  }
  return config;
}

const idFor = (absPath) =>
  crypto.createHash('sha1').update(absPath.toLowerCase()).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- scanning

// Walk a game folder once. Returns the nested tree, a flat list of every file
// (which the cover heuristic scores), and a signature of every directory's
// mtime so a later launch can tell whether this game changed without
// re-walking it.
async function walkGame(root) {
  const flat = [];
  const dirSig = [];
  let nodes = 0;

  async function noteDir(abs) {
    try {
      const st = await fsp.stat(abs);
      dirSig.push([abs, Math.floor(st.mtimeMs)]);
    } catch {
      dirSig.push([abs, -1]);
    }
  }

  async function walk(dir, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      if (nodes >= MAX_TREE_NODES) break;
      if (entry.name.startsWith('.') || entry.name === 'Thumbs.db') continue;
      const abs = path.join(dir, entry.name);
      nodes++;

      if (entry.isDirectory()) {
        await noteDir(abs);
        const children = depth < MAX_TREE_DEPTH ? await walk(abs, depth + 1) : [];
        out.push({ type: 'dir', name: entry.name, path: abs, depth, children });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        let size = 0, mtime = 0;
        try {
          const st = await fsp.stat(abs);
          size = st.size;
          mtime = st.mtimeMs;
        } catch { /* unreadable — still list it */ }
        const node = {
          type: 'file', name: entry.name, path: abs, ext, size, mtime, depth,
          kind: KIND_BY_EXT[ext] || 'other',
        };
        out.push(node);
        flat.push(node);
      }
    }
    // Folders first, then files, each alphabetical — matches Explorer.
    out.sort((a, b) =>
      a.type !== b.type
        ? (a.type === 'dir' ? -1 : 1)
        : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return out;
  }

  await noteDir(root);
  const tree = await walk(root, 0);
  return { tree, flat, dirSig, truncated: nodes >= MAX_TREE_NODES };
}

// Strip edition/format noise so a filename can be compared to the folder name.
const normalize = (s) =>
  s.toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[\(\[].*?[\)\]]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// Score every PDF in the game and return the most likely core book.
// Deliberately generous: the UI lets the user override any wrong guess.
function pickMainBook(gameName, flat) {
  const pdfs = flat.filter((f) => f.ext === '.pdf');
  if (!pdfs.length) {
    // No PDF? Fall back to the biggest image — some folders ship a cover jpg.
    const imgs = flat.filter((f) => IMAGE_EXTS.has(f.ext));
    if (!imgs.length) return null;
    imgs.sort((a, b) => b.size - a.size);
    return { kind: 'image', path: imgs[0].path };
  }

  const gameNorm = normalize(gameName);
  const maxSize = Math.max(...pdfs.map((p) => p.size)) || 1;

  let best = null;
  let bestScore = -Infinity;

  for (const pdf of pdfs) {
    const base = pdf.name;
    const norm = normalize(base);
    let score = 0;

    if (CORE_RE.test(base)) score += 100;
    if (SUPPLEMENT_RE.test(base)) score -= 90;

    // The file is basically named after the game.
    if (gameNorm && (norm === gameNorm || norm.startsWith(gameNorm + ' ') || norm === gameNorm + ' rpg')) {
      score += 70;
    } else if (gameNorm && norm.includes(gameNorm)) {
      score += 30;
    }

    // A folder literally called "Core" is a strong signal.
    if (/(^|[\\\/])core([\\\/]|$)/i.test(path.dirname(pdf.path))) score += 45;

    // Core books are big. Normalised so it never dominates the name signals.
    score += (pdf.size / maxSize) * 35;

    // Prefer files near the top of the game folder.
    score -= pdf.depth * 6;

    if (score > bestScore) {
      bestScore = score;
      best = pdf;
    }
  }

  return best ? { kind: 'pdf', path: best.path } : null;
}

async function buildGame(name, abs) {
  const id = idFor(abs);
  const { tree, flat, dirSig, truncated } = await walkGame(abs);

  let stat = null;
  try { stat = await fsp.stat(abs); } catch { /* ignore */ }

  // A manual override wins — but only if the file still exists. A stale/missing
  // override falls back to the in-folder auto-pick, so a cover never points at a
  // file that has moved or been deleted. Auto-picks come from `flat`, which only
  // contains files inside this game's folder, so they are always in-folder.
  const override = config.coverOverrides[id];
  const cover = (override && fs.existsSync(override))
    ? { kind: IMAGE_EXTS.has(path.extname(override).toLowerCase()) ? 'image' : 'pdf', path: override }
    : pickMainBook(name, flat);

  return {
    id,
    name,
    path: abs,
    tree,
    dirSig,
    truncated,
    cover,                                   // {kind:'pdf'|'image', path} | null
    coverPage: config.coverPages[id] || 1,
    cachedCover: cachedCoverUrl(id),         // null until rendered once
    counts: {
      total: flat.length,
      pdf: flat.filter((f) => f.kind === 'pdf').length,
      image: flat.filter((f) => f.kind === 'image').length,
      text: flat.filter((f) => f.kind === 'text').length,
      folders: tree.filter((n) => n.type === 'dir').length,
    },
    bytes: flat.reduce((n, f) => n + f.size, 0),
    addedAt: stat ? Math.floor(stat.mtimeMs / 1000) : 0,
  };
}

// ---------------------------------------------------------------- index

// The scanned library is cached to disk so a relaunch paints instantly instead
// of re-walking 511 folders and 7,000 files. Bump the version whenever the game
// shape changes — a stale-shaped index is discarded rather than migrated.
const INDEX_VERSION = 2;
const indexPath = () => path.join(userDir(), 'library-index.json');

function loadIndex(root) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    if (idx.version !== INDEX_VERSION || idx.root !== root) return null;
    if (!Array.isArray(idx.games)) return null;
    return idx;
  } catch {
    return null;
  }
}

function saveIndex(root, games) {
  try {
    fs.mkdirSync(userDir(), { recursive: true });
    fs.writeFileSync(indexPath(),
      JSON.stringify({ version: INDEX_VERSION, root, scannedAt: Date.now(), games }), 'utf8');
  } catch (err) {
    console.error('[index] save failed:', err.message);
  }
}

// Patch one game in the saved index without rewriting everything from a scan.
function patchIndexGame(id, patch) {
  const idx = loadIndex(config.root);
  if (!idx) return;
  const g = idx.games.find((x) => x.id === id);
  if (!g) return;
  Object.assign(g, patch);
  saveIndex(idx.root, idx.games);
}

// A game is stale if any directory inside it has a different mtime than when we
// last walked it. A directory's mtime changes whenever a file is added,
// removed, or renamed inside it, so this catches everything that would change
// the listing — ~700 stats for the whole library instead of ~7,000.
async function isStale(game) {
  if (!Array.isArray(game.dirSig) || !game.dirSig.length) return true;
  for (const [p, m] of game.dirSig) {
    try {
      const st = await fsp.stat(p);
      if (Math.floor(st.mtimeMs) !== m) return true;
    } catch {
      return true;
    }
  }
  return false;
}

let scanToken = 0;

// Paint from the cached index immediately, then revalidate in the background
// and push only the games that actually changed.
async function scanLibrary(win, root, force) {
  const token = ++scanToken;
  const send = (ch, payload) => {
    if (win && !win.isDestroyed() && token === scanToken) win.webContents.send(ch, payload);
  };

  const cached = force ? null : loadIndex(root);
  if (cached) {
    // Covers may have been rendered or cleared since the index was written.
    for (const g of cached.games) g.cachedCover = cachedCoverUrl(g.id);
    send('library-cached', { root, games: cached.games });
  }

  let dirents;
  try {
    dirents = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `Cannot read ${root}: ${err.message}`, games: [] };
  }

  const dirs = dirents.filter((d) => d.isDirectory() && !d.name.startsWith('.'));
  const prevById = new Map((cached?.games || []).map((g) => [g.id, g]));
  const games = [];
  let rebuilt = 0;

  for (const d of dirs) {
    if (token !== scanToken) return { ok: false, error: 'superseded', games: [] };
    const abs = path.join(root, d.name);
    const prev = prevById.get(idFor(abs));

    if (prev && !(await isStale(prev))) {
      games.push(prev);
      continue;
    }

    const game = await buildGame(d.name, abs);
    games.push(game);
    rebuilt++;
    send('game-scanned', game);
  }

  const live = new Set(games.map((g) => g.id));
  const removed = (cached?.games || []).filter((g) => !live.has(g.id)).map((g) => g.id);

  saveIndex(root, games);
  send('scan-done', { count: games.length, rebuilt, removed, fromCache: !!cached });
  return { ok: true, root, games };
}

// ---------------------------------------------------------------- covers

const coverFile = (id) => path.join(coverDir(), `${id}.png`);

function cachedCoverUrl(id) {
  const f = coverFile(id);
  try {
    const st = fs.statSync(f);
    // Cache-bust on mtime so a re-render shows up immediately.
    return imgUrl(f) + '?v=' + Math.floor(st.mtimeMs);
  } catch {
    return null;
  }
}

function imgUrl(absPath) {
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'biblio-img://local' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

// Serve a file off disk with real Range support. pdf.js needs this: without
// `Accept-Ranges` it downloads the entire book just to rasterise page 1, and
// some of these core books are hundreds of megabytes.
async function serveLocalFile(request) {
  let abs;
  try {
    const u = new URL(request.url);
    let p = decodeURIComponent(u.pathname);
    if (p.startsWith('/')) p = p.slice(1);
    abs = path.normalize(p);
  } catch {
    return new Response('bad url', { status: 400 });
  }

  let st;
  try {
    st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return new Response('not found', { status: 404 });
  }

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const baseHeaders = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };

  const range = request.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);
    if (start === null) {
      // Suffix range: last N bytes.
      start = Math.max(0, st.size - (end || 0));
      end = st.size - 1;
    } else if (end === null || end >= st.size) {
      end = st.size - 1;
    }
    if (start > end || start >= st.size) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${st.size}` },
      });
    }
    const stream = fs.createReadStream(abs, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(abs)), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(st.size) },
  });
}

// ---------------------------------------------------------------- window

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1410',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Anything trying to open a new window goes to the OS browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'biblio-img', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

app.whenReady().then(() => {
  loadConfig();
  fs.mkdirSync(coverDir(), { recursive: true });

  protocol.handle('biblio-img', serveLocalFile);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- ipc

ipcMain.handle('get-config', () => config);

ipcMain.handle('save-config', (_e, partial) => saveConfig(partial));

// Toggle a game's favorite state; returns the new state.
ipcMain.handle('toggle-favorite', (_e, id) => {
  if (!id) return false;
  const set = new Set(config.favorites);
  const now = !set.has(id);
  if (now) set.add(id); else set.delete(id);
  saveConfig({ favorites: [...set] });
  return now;
});

// Record that a game was opened; returns the updated recent-games list.
ipcMain.handle('note-opened', (_e, id) => {
  if (!id) return config.recentGames;
  const next = [id, ...config.recentGames.filter((x) => x !== id)].slice(0, RECENT_LIMIT);
  saveConfig({ recentGames: next });
  return next;
});

// Replace a game's metadata tags; returns the stored list.
ipcMain.handle('set-tags', (_e, id, tags) => {
  if (!id) return [];
  // Normalise: trim, drop blanks, de-duplicate (case-insensitive), cap length.
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40);
    const key = t.toLowerCase();
    if (t && !seen.has(key)) { seen.add(key); clean.push(t); }
  }
  const next = { ...config.tags };
  if (clean.length) next[id] = clean; else delete next[id];
  saveConfig({ tags: next });
  return clean;
});

ipcMain.handle('scan-library', async (e, root, force) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const target = root || config.root || DEFAULT_ROOT;
  if (target !== config.root) saveConfig({ root: target });
  return scanLibrary(win, target, !!force);
});

ipcMain.handle('choose-root', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose your TTRPG folder',
    properties: ['openDirectory'],
    defaultPath: config.root || DEFAULT_ROOT,
  });
  if (res.canceled || !res.filePaths.length) return null;
  saveConfig({ root: res.filePaths[0] });
  return res.filePaths[0];
});

// The renderer rasterises page 1 with pdf.js and hands back a PNG data URL.
ipcMain.handle('save-cover', async (_e, id, dataUrl) => {
  if (!id || typeof dataUrl !== 'string') return null;
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    await fsp.mkdir(coverDir(), { recursive: true });
    await fsp.writeFile(coverFile(id), Buffer.from(m[1], 'base64'));
    const url = cachedCoverUrl(id);
    patchIndexGame(id, { cachedCover: url });
    return url;
  } catch (err) {
    console.error('[cover] write failed:', err.message);
    return null;
  }
});

ipcMain.handle('clear-cover', async (_e, id) => {
  try { await fsp.unlink(coverFile(id)); } catch { /* already gone */ }
  patchIndexGame(id, { cachedCover: null });
  return true;
});

// Give the renderer a readable URL for a source file (used for image covers
// and for the pdf bytes pdf.js loads).
ipcMain.handle('file-url', (_e, absPath) => imgUrl(absPath));

ipcMain.handle('set-cover-override', async (e, id, absPath, page) => {
  const overrides = { ...config.coverOverrides };
  const pages = { ...config.coverPages };
  if (absPath) {
    overrides[id] = absPath;
    pages[id] = Math.max(1, page || 1);
  } else {
    delete overrides[id];
    delete pages[id];
  }
  saveConfig({ coverOverrides: overrides, coverPages: pages });
  try { await fsp.unlink(coverFile(id)); } catch { /* no cache yet */ }

  // Keep the index in step, or the next launch would paint the old cover
  // source until that game happened to look stale.
  patchIndexGame(id, absPath
    ? {
        cachedCover: null,
        coverPage: pages[id] || 1,
        cover: { kind: IMAGE_EXTS.has(path.extname(absPath).toLowerCase()) ? 'image' : 'pdf', path: absPath },
      }
    // Override cleared — an empty signature forces the next scan to re-derive
    // this game's cover from the heuristic.
    : { cachedCover: null, coverPage: 1, dirSig: [] });
  return { override: overrides[id] || null, page: pages[id] || 1 };
});

// Let the user point at any image/pdf as a game's cover. Defaults to the game's
// own folder so covers naturally stay in-folder.
ipcMain.handle('pick-cover-file', async (e, defaultPath) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a cover',
    properties: ['openFile'],
    filters: [
      { name: 'Cover source', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
    ],
    defaultPath: defaultPath || config.root || DEFAULT_ROOT,
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// Hand a file to whatever program the OS has registered for it.
ipcMain.handle('open-path', async (_e, absPath) => {
  if (!absPath) return 'no path';
  const err = await shell.openPath(absPath);
  if (!err) {
    const recents = [absPath, ...config.recents.filter((r) => r !== absPath)].slice(0, 24);
    saveConfig({ recents });
  }
  return err; // '' on success
});

ipcMain.handle('show-in-folder', async (_e, absPath) => {
  if (!absPath) return 'no path';
  // shell.showItemInFolder is unreliable for *directories* on Windows (it is
  // built to reveal files), and a game's path is a folder. Reveal it with
  // Explorer's own /select verb, which selects the item in its parent and
  // brings the window to the foreground.
  if (process.platform === 'win32') {
    // Windows paths can't contain '"', so quoting is injection-safe. explorer.exe
    // returns exit code 1 even on success, so the error is ignored.
    require('child_process').exec(`explorer.exe /select,"${path.normalize(absPath)}"`);
    return '';
  }
  shell.showItemInFolder(absPath);
  return '';
});
