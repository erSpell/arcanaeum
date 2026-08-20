/* ═══════════════════════════ RENDERER ═══════════════════════════════════
   Ported from the Claude Design handoff onto the live Electron backend.

   Two changes from the handoff:
     1. buildCover() now runs the real pdf.js rasterisation pipeline instead
        of the mock's _renderMockCover — this is the one spot the brief marked
        for the real backend.
     2. chooseCover() prompts for a PDF page (the handoff hard-coded page 1).

   Everything else — the incremental grid (build once, mutate in place, sort
   with CSS order/hidden), the lazy bounded-concurrency cover queue, the
   signature hover, the ledger, the backend wiring — is the design verbatim. */
"use strict";

import * as pdfjsLib from './vendor/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';

const $=(s,el=document)=>el.querySelector(s);
const REDUCED=matchMedia("(prefers-reduced-motion:reduce)").matches;

const state={games:[],byId:new Map(),filter:"",sort:"name",view:"all",cardSize:178,theme:"archive",
  favorites:new Set(),recentGames:[],tags:new Map(),excludedTags:new Set(),
  scanning:true,open:null,expanded:new Set(),error:null};
const CARD_SIZE_MIN=128,CARD_SIZE_MAX=260;

// Theme metadata for the switcher panel. The actual palettes live in styles.css
// as [data-theme="…"] blocks; wood/brass here are only for drawing the little
// swatch preview (each row must show ITS OWN theme's colors, not the live one).
const THEMES=[
  {id:"archive",name:"Green",desc:"A muted green accent on a dark neutral ground.",wood:"#1a1815",brass:"#7fa06c"},
  {id:"hollow",name:"Blue",desc:"A cool slate-blue accent.",wood:"#171a1c",brass:"#5f86a3"},
  {id:"hearth",name:"Amber",desc:"A warm amber-red accent.",wood:"#1c1614",brass:"#c96b3e"},
  {id:"harvest",name:"Gold",desc:"A rich gold accent.",wood:"#1c1710",brass:"#cf9f3f"},
];
function applyTheme(id){document.documentElement.setAttribute("data-theme",id);}

// Tags for a game (client-side, mirrors config like favourites).
const tagsFor=(id)=>state.tags.get(id)||[];
const COVER_CONCURRENCY=3;
const COVER_WIDTH=420;                 // px width of the cached cover PNG

// Authored star icon (favourite toggle) — outline when unset, filled when set.
const STAR_OUTLINE=`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7L1 9.2l7.1-.6z"/></svg>`;
const STAR_FILLED=`<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.8-6.2 3.8 1.6-7L1 9.2l7.1-.6z"/></svg>`;
// Authored disclosure chevron for the ledger's file tree.
const CHEV_ICON=`<svg viewBox="0 0 8 8" width="7" height="7" fill="currentColor"><path d="M1 0l6 4-6 4z"/></svg>`;
// Content-warning glyph — a tag reading this never carries its meaning by
// color alone, so it still reads on a screen reader or in high-contrast mode.
const WARN_ICON=`<svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.6 14.8 13.6a1 1 0 0 1-.87 1.5H2.07a1 1 0 0 1-.87-1.5L8 1.6Z"/><path d="M8 6.2v3.6M8 12.1h.01"/></svg>`;
const isWarnTag=t=>/^(nsfw|cw|content\s*warning)\b/i.test(String(t).trim());

const fmtBytes=n=>{if(!n)return"—";const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return`${n<10&&i>0?n.toFixed(1):Math.round(n)} ${u[i]}`;};
const fmtInt=n=>n.toLocaleString("en-US");
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

function sortComparator(){
  if(state.sort==="name")return(a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
  if(state.sort==="size")return(a,b)=>b.bytes-a.bytes;
  if(state.sort==="count")return(a,b)=>b.counts.total-a.counts.total;
  return(a,b)=>b.addedAt-a.addedAt;
}
function visibleGames(){
  const q=state.filter.trim().toLowerCase();
  let out=state.games.slice();
  // view filter
  if(state.view==="favorites")out=out.filter(g=>state.favorites.has(g.id));
  else if(state.view==="recent"){const seen=new Set(state.recentGames);out=out.filter(g=>seen.has(g.id));}
  // text filter — matches the title OR any of the game's tags. A leading "#"
  // narrows the match to tags only (e.g. "#osr").
  if(q){
    if(q.startsWith("#")){const tq=q.slice(1).trim();
      out=tq?out.filter(g=>tagsFor(g.id).some(t=>t.toLowerCase().includes(tq))):out;}
    else out=out.filter(g=>g.name.toLowerCase().includes(q)||tagsFor(g.id).some(t=>t.toLowerCase().includes(q)));
  }
  // excluded tags (session-only) — hide any game carrying an unchecked tag
  if(state.excludedTags.size)out=out.filter(g=>!tagsFor(g.id).some(t=>state.excludedTags.has(t)));
  // ordering: Recent is always newest-opened first; everything else honours the sort control
  if(state.view==="recent"){const rank=new Map(state.recentGames.map((id,i)=>[id,i]));out.sort((a,b)=>rank.get(a.id)-rank.get(b.id));}
  else out.sort(sortComparator());
  return out;
}

/* ─────────────── COVER PIPELINE (lazy, scroll-aware, bounded) ───────────── */
// Only ~half the library ships with a cached PNG; the rest are rasterised from
// their PDF with pdf.js on demand, which is CPU-heavy. So: never rasterise mid-
// scroll, drop jobs for cards flung past, and quietly pre-cache the rest on idle.
const coverQueue=[]; const coverDone=new Set(); const queued=new Set(); let coverActive=0;
let scrollIdle=true;

// Measure the .book itself — it is the content-visibility:auto element. Measuring
// a descendant (.plate) would force the browser to render the culled subtree and
// defeat the whole optimisation, so band checks ALWAYS use rec.el.
function nearViewport(rec,margin){
  const r=rec.el.getBoundingClientRect();
  return r.bottom>-margin && r.top<innerHeight+margin;
}

function queueCover(game){
  if(coverDone.has(game.id)||queued.has(game.id))return;
  queued.add(game.id);coverQueue.push(game.id);pumpCovers();
}
function pumpCovers(){
  if(!scrollIdle)return;                       // don't rasterise while scrolling
  while(coverActive<COVER_CONCURRENCY&&coverQueue.length){
    const id=coverQueue.shift();queued.delete(id);
    const game=state.byId.get(id);
    if(!game||game.cachedCover||coverDone.has(game.id))continue;
    const rec=cards.get(id);
    if(rec&&!nearViewport(rec,700))continue;   // flung past — the observer re-queues it if it returns
    coverDone.add(game.id);coverActive++;
    buildCover(game).then(url=>{if(url)applyCover(game.id,url);})
      .catch(e=>console.warn("[cover]",game.name,e))
      .finally(()=>{coverActive--;pumpCovers();scheduleIdlePrecache();});
  }
}
function applyCover(id,url){const g=state.byId.get(id);if(g)g.cachedCover=url;const rec=cards.get(id);if(rec&&g)updateCard(rec,g);}

// Once nothing on-screen needs rendering, quietly fill the rest of the cache so
// later scrolling is instant everywhere. One at a time, and it yields the moment
// the user scrolls or an on-screen cover needs priority.
let precacheTimer=null;
function scheduleIdlePrecache(){clearTimeout(precacheTimer);precacheTimer=setTimeout(precacheNext,1500);}
function precacheNext(){
  if(!scrollIdle||coverActive>0||coverQueue.length){scheduleIdlePrecache();return;}
  const g=state.games.find(x=>x.cover&&!x.cachedCover&&!coverDone.has(x.id));
  if(!g)return;                                // whole library cached — done
  coverDone.add(g.id);coverActive++;
  buildCover(g).then(url=>{if(url)applyCover(g.id,url);})
    .catch(()=>{}).finally(()=>{coverActive--;scheduleIdlePrecache();});
}

/* ── real backend: fileUrl → pdf.js rasterise → saveCover ──────────────────
   Renders page 1 of the game's main sourcebook (or a chosen image) to a PNG
   and hands it to the backend to cache. Only ever called for a book scrolled
   into view, and never twice for the same game. */
async function buildCover(game){
  if(game.cachedCover)return game.cachedCover;
  if(!game.cover)return null;
  const src=await window.lib.fileUrl(game.cover.path);
  const canvas=game.cover.kind==="image"
    ? await rasteriseImage(src)
    // Only auto-skip blank pages when the page wasn't chosen by hand.
    : await rasterisePdfPage(src,game.coverPage||1,!game.coverPage||game.coverPage===1);
  if(!canvas)return null;
  return window.lib.saveCover(game.id,canvas.toDataURL("image/png"));
}

async function rasteriseImage(url){
  const img=new Image();img.decoding="async";
  await new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error("image load failed"));img.src=url;});
  const scale=Math.min(1,COVER_WIDTH/img.naturalWidth);
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
  canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
  canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
  return canvas;
}

// Fraction of the page that carries ink, measured on a 64px thumbnail against
// the page's own median luminance. A real cover scores well above BLANK_LIMIT;
// a half-title page with one small device scores near zero.
function inkCoverage(canvas){
  const N=64;
  const small=document.createElement("canvas");small.width=small.height=N;
  const ctx=small.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(canvas,0,0,N,N);
  const px=ctx.getImageData(0,0,N,N).data;
  const lum=new Array(N*N);
  for(let i=0,p=0;i<px.length;i+=4,p++)lum[p]=0.299*px[i]+0.587*px[i+1]+0.114*px[i+2];
  const median=lum.slice().sort((a,b)=>a-b)[lum.length>>1];
  let inked=0;for(const l of lum)if(Math.abs(l-median)>14)inked++;
  return inked/lum.length;
}
const BLANK_LIMIT=0.03;
const BLANK_LOOKAHEAD=2;               // extra pages to try past a blank-looking page 1

async function renderPage(doc,pageNum){
  const page=await doc.getPage(pageNum);
  const base=page.getViewport({scale:1});
  const viewport=page.getViewport({scale:COVER_WIDTH/base.width});
  const canvas=document.createElement("canvas");
  canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
  await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
  page.cleanup();
  return canvas;
}

async function rasterisePdfPage(url,pageNum,allowLookahead){
  const task=pdfjsLib.getDocument({
    url,
    // Range requests are served by the biblio-img protocol handler, so pdf.js
    // pulls only the bytes it needs instead of the whole book.
    rangeChunkSize:262144,
    disableAutoFetch:true,
    disableStream:false,
    cMapUrl:"./vendor/cmaps/",
    cMapPacked:true,
    standardFontDataUrl:"./vendor/standard_fonts/",
  });
  const doc=await task.promise;
  try{
    const start=Math.min(Math.max(1,pageNum),doc.numPages);
    let best=await renderPage(doc,start);
    let bestInk=inkCoverage(best);
    // Plenty of these PDFs open on a blank or half-title page. Walk forward a
    // couple of pages and keep whichever is busiest — never worse than page 1.
    if(allowLookahead&&bestInk<BLANK_LIMIT){
      for(let p=start+1;p<=Math.min(start+BLANK_LOOKAHEAD,doc.numPages);p++){
        const cand=await renderPage(doc,p);
        const ink=inkCoverage(cand);
        if(ink>bestInk){best=cand;bestInk=ink;}
        if(bestInk>=BLANK_LIMIT)break;
      }
    }
    return best;
  }finally{
    doc.destroy();
    task.destroy?.();
  }
}

// Observe the .book (the content-visibility element), not the .plate inside it.
// We do NOT unobserve on first intersect: a card flung past may have its job
// dropped, and must re-queue when it re-enters the viewport.
const coverObserver=new IntersectionObserver(entries=>{
  for(const e of entries){if(!e.isIntersecting)continue;
    const g=state.byId.get(e.target.dataset.game);
    if(g&&!g.cachedCover)queueCover(g);}
},{rootMargin:"500px 0px"});
// After a fast fling, in-view cards were already observed (fired on the way in)
// and won't fire again, so on scroll-settle we re-scan the visible band. Uses
// rec.el, so it never forces the culled subtrees to render.
let primeT=null;
function primeVisible(){
  for(const[,rec]of cards){
    const g=state.byId.get(rec.el.dataset.game);
    if(!g||g.cachedCover||rec.el.hidden||!g.cover)continue;
    if(nearViewport(rec,500))queueCover(g);
  }
}
function schedulePrime(){clearTimeout(primeT);primeT=setTimeout(()=>{primeVisible();pumpCovers();},80);}

/* ─────────────────────────────── VIEW ──────────────────────────────────── */
const root=$("#root");
let gridEl,emptyEl,countEl,stacksEl;
const cards=new Map();

function mountChrome(){
  root.innerHTML=`
    <div class="rail">
      <div class="brand"><b>Arcanaeum</b><small>of Other Worlds</small></div>
      <div class="seg" id="view">
        <button data-view="all">All</button>
        <button data-view="favorites">Favourites</button>
        <button data-view="recent">Recent</button>
      </div>
      <input class="search" id="search" placeholder="Search titles &amp; tags  (try #osr)" spellcheck="false">
      <button class="rail-btn" id="tagFilter" title="Show or hide books by tag">Tags ▾</button>
      <div class="seg" id="sort">
        <button data-sort="name">Title</button>
        <button data-sort="size">Weight</button>
        <button data-sort="count">Volumes</button>
        <button data-sort="date">Acquired</button>
      </div>
      <div class="rail-spacer"></div>
      <div class="sizectl" title="Shelf size">
        <span class="sizectl-ico small" aria-hidden="true">▪</span>
        <input type="range" id="cardSize" min="${CARD_SIZE_MIN}" max="${CARD_SIZE_MAX}" step="2" value="${state.cardSize}" aria-label="Book size">
        <span class="sizectl-ico big" aria-hidden="true">▪</span>
      </div>
      <div class="count" id="count"></div>
      <div class="rail-actions">
        <button class="rail-btn" id="themeBtn" title="Change the look">Theme ▾</button>
        <button class="rail-btn deliberate" id="rescan" title="Forget the cached index and re-walk every folder">Rescan</button>
        <button class="rail-btn deliberate" id="chooseRoot" title="Point the Library at a different root folder — replaces the current view">Change folder</button>
      </div>
    </div>
    <div class="stacks" id="stacks">
      <div class="grid" id="grid"></div>
      <div class="empty" id="empty"></div>
    </div>`;
  gridEl=$("#grid");emptyEl=$("#empty");countEl=$("#count");stacksEl=$("#stacks");

  $("#search").addEventListener("input",e=>{state.filter=e.target.value;paint();});
  $("#view").addEventListener("click",e=>{const b=e.target.closest("[data-view]");if(!b)return;
    state.view=b.dataset.view;paint();});
  $("#sort").addEventListener("click",e=>{const b=e.target.closest("[data-sort]");if(!b)return;
    state.sort=b.dataset.sort;window.lib.saveConfig({sort:state.sort});paint();});
  $("#rescan").addEventListener("click",()=>startScan(undefined,true));
  $("#chooseRoot").addEventListener("click",async()=>{const p=await window.lib.chooseRoot();if(p)startScan(p,true);});
  $("#tagFilter").addEventListener("click",e=>toggleTagFilterPanel(e.currentTarget));
  $("#themeBtn").addEventListener("click",e=>toggleThemePanel(e.currentTarget));

  // Shelf size — live while dragging, persisted only once the user lets go.
  const sizeSlider=$("#cardSize");
  sizeSlider.addEventListener("input",e=>{
    state.cardSize=Number(e.target.value);
    document.documentElement.style.setProperty("--card-min",`${state.cardSize}px`);
  });
  sizeSlider.addEventListener("change",e=>window.lib.saveConfig({cardSize:Number(e.target.value)}));

  // Pause pdf.js rasterisation while scrolling; resume — and re-scan the visible
  // band — once the scroll settles. This is what keeps fast scrolling smooth.
  let scrollStopT=null;
  stacksEl.addEventListener("scroll",()=>{
    scrollIdle=false;clearTimeout(precacheTimer);
    clearTimeout(scrollStopT);
    scrollStopT=setTimeout(()=>{scrollIdle=true;primeVisible();pumpCovers();},140);
  },{passive:true});

}

function paint(){
  const list=visibleGames();
  syncGrid(list);
  const denom=state.view==="all"?state.games.length:list.length;
  const scope=state.view==="favorites"?" favourited":state.view==="recent"?" recent":"";
  const tagHint=state.filter.trim()==="#"?` · <em>type a tag to narrow</em>`:"";
  countEl.innerHTML=`${fmtInt(list.length)}${state.view==="all"?` of ${fmtInt(denom)}`:scope}${tagHint}${state.scanning?` · <em>cataloguing<span class="dots"></span></em>`:""}`;
  for(const b of document.querySelectorAll("[data-view]"))b.classList.toggle("on",b.dataset.view===state.view);
  // Recent is ordered by recency, so the sort control does not apply there.
  const sortSeg=$("#sort");if(sortSeg)sortSeg.classList.toggle("muted",state.view==="recent");
  for(const b of document.querySelectorAll("[data-sort]"))b.classList.toggle("on",b.dataset.sort===state.sort&&state.view!=="recent");
  updateTagFilterButton();
}

function syncGrid(list){
  const rank=new Map(list.map((g,i)=>[g.id,i]));
  for(const game of state.games){
    let rec=cards.get(game.id);
    if(!rec){rec=makeCard(game);cards.set(game.id,rec);gridEl.appendChild(rec.el);}
    updateCard(rec,game);
    const i=rank.get(game.id);
    if(i===undefined){rec.el.hidden=true;}
    else{rec.el.hidden=false;rec.el.style.order=String(i);}
  }
  for(const[id,rec]of cards){if(!state.byId.has(id)){rec.el.remove();cards.delete(id);}}
  updateEmpty(list.length);
  schedulePrime();
}

function updateEmpty(n){
  emptyEl.className="empty";
  if(state.error){emptyEl.classList.add("show","err");
    emptyEl.innerHTML=`<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 7l2-3h5l2 3h7v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 12h6M12 9v6" opacity=".5"/></svg>
      <div class="eh">The shelves are missing</div>
      <div class="ep">${esc(state.error)}. Point the Library at another folder to begin cataloguing.</div>
      <button class="rail-btn deliberate" id="errChoose">Change folder</button>`;
    $("#errChoose").onclick=async()=>{const p=await window.lib.chooseRoot();if(p)startScan(p,true);};
    return;}
  if(n>0)return;
  emptyEl.classList.add("show");
  if(state.scanning){
    emptyEl.innerHTML=`<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 5h6v14H4zM10 5h4v14h-4zM14 5h6v14h-6z"/></svg>
      <div class="eh">Cataloguing the stacks<span class="dots"></span></div>
      <div class="ep">Reading the index. The shelves will fill as each game is found.</div>`;return;}
  if(state.filter){
    emptyEl.innerHTML=`<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="10" cy="10" r="6"/><path d="M15 15l5 5"/></svg>
      <div class="eh">Nothing matches “${esc(state.filter)}”</div>
      <div class="ep">No ${state.view==="favorites"?"favourite":state.view==="recent"?"recently-opened":""} game answers to that name. Try a shorter fragment.</div>`;return;}
  if(state.view==="favorites"){
    emptyEl.innerHTML=`<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 3l2.6 5.6 6 .7-4.4 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.4 9.3l6-.7z"/></svg>
      <div class="eh">No favourites yet</div>
      <div class="ep">Hover a book and tap its star, or right-click one, to shelve it here.</div>`;return;}
  if(state.view==="recent"){
    emptyEl.innerHTML=`<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
      <div class="eh">Nothing opened yet</div>
      <div class="ep">Books you open appear here, most recent first.</div>`;return;}
  emptyEl.innerHTML=`<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M4 5h6v14H4zM10 5h4v14h-4zM14 5h6v14h-6z"/></svg>
    <div class="eh">Nothing on these shelves</div>
    <div class="ep">This folder holds no game subfolders. Use “Change folder” to point elsewhere.</div>`;
}

function makeCard(game){
  const el=document.createElement("div");el.className="book";el.dataset.game=game.id;
  el.innerHTML=`
    <button class="fav-star" title="Favourite" aria-label="Favourite">${STAR_OUTLINE}</button>
    <div class="plate-wrap"><div class="plate" data-cover="${esc(game.id)}">
      <div class="sheen"></div>
    </div></div>
    <div class="cap"><div class="t"></div><div class="s"></div><div class="card-tags"></div><div class="plate-rule"></div></div>`;
  const rec={el,plate:$(".plate",el),wrap:$(".plate-wrap",el),t:$(".t",el),s:$(".s",el),star:$(".fav-star",el),tagsEl:$(".card-tags",el),fav:undefined,tagKey:undefined,coverUrl:undefined,observed:false};
  const current=()=>state.byId.get(el.dataset.game);

  rec.star.addEventListener("click",ev=>{ev.stopPropagation();const g=current();if(g)toggleFav(g);});

  el.addEventListener("pointerenter",()=>el.classList.add("hot"));
  el.addEventListener("pointerleave",()=>el.classList.remove("hot"));
  if(!REDUCED){
    // No 3D tilt — a flat lift only, so the cover never warps. The gilt sheen
    // still follows the cursor.
    el.addEventListener("pointermove",ev=>{
      const r=rec.plate.getBoundingClientRect();
      rec.plate.style.setProperty("--mx",`${((ev.clientX-r.left)/r.width)*100}%`);
      rec.plate.style.setProperty("--my",`${((ev.clientY-r.top)/r.height)*100}%`);
    });
  }
  el.addEventListener("click",()=>{const g=current();if(g)openLedger(g);});
  el.addEventListener("contextmenu",ev=>{ev.preventDefault();const g=current();if(g)showMenu(ev.clientX,ev.clientY,g);});
  el.tabIndex=0;el.setAttribute("role","button");
  el.addEventListener("keydown",ev=>{
    if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();const g=current();if(g)openLedger(g);}
  });
  return rec;
}

function updateCard(rec,game){
  const sub=game.counts.folders
    ?[game.counts.pdf?`${game.counts.pdf} pdf`:null,`${game.counts.folders} vol`].filter(Boolean).join(" · ")
    :(game.counts.pdf?`${game.counts.pdf} pdf`:fmtBytes(game.bytes));
  if(rec.t.textContent!==game.name)rec.t.textContent=game.name;
  if(rec.s.textContent!==sub)rec.s.textContent=sub;
  if(rec.el.title!==game.name)rec.el.title=game.name;
  if(rec.el.getAttribute("aria-label")!==game.name)rec.el.setAttribute("aria-label",game.name);
  const fav=state.favorites.has(game.id);
  if(rec.fav!==fav){rec.fav=fav;rec.el.classList.toggle("fav",fav);rec.star.innerHTML=fav?STAR_FILLED:STAR_OUTLINE;
    rec.star.title=fav?"Remove from favourites":"Add to favourites";}
  const tags=tagsFor(game.id);
  const tagKey=tags.join("");
  if(rec.tagKey!==tagKey){rec.tagKey=tagKey;
    rec.tagsEl.innerHTML=tags.slice(0,3).map(t=>`<span class="ctag${isWarnTag(t)?" warn":""}">${isWarnTag(t)?WARN_ICON:""}${esc(t)}</span>`).join("")
      +(tags.length>3?`<span class="ctag more">+${tags.length-3}</span>`:"");}
  if(rec.coverUrl===game.cachedCover)return;          // only touch <img> when URL actually changed
  rec.coverUrl=game.cachedCover;
  const furniture=`<div class="sheen"></div>`;
  if(game.cachedCover){
    const mount=document.createElement("div");mount.className="cover-mount";
    const img=document.createElement("img");img.alt="";img.draggable=false;img.decoding="async";img.src=game.cachedCover;
    mount.appendChild(img);
    rec.plate.innerHTML=furniture;rec.plate.insertBefore(mount,rec.plate.firstChild);
    if(rec.observed){coverObserver.unobserve(rec.el);rec.observed=false;}
  }else{
    const pending=!!game.cover;
    rec.plate.innerHTML=`<div class="fallback${pending?" pending":""}">
      <div class="fb-title">${esc(game.name)}</div><div class="fb-rule"></div>
      <div class="fb-mark">${pending?"Rendering":"No cover"}</div></div>${furniture}`;
    if(!rec.observed){coverObserver.observe(rec.el);rec.observed=true;}
  }
}

/* ─────────────────────── FAVOURITES / RECENTLY OPENED ───────────────────── */
async function toggleFav(game){
  const now=await window.lib.toggleFavorite(game.id);
  if(now)state.favorites.add(game.id);else state.favorites.delete(game.id);
  paint();                                    // updates the star + drops it from the Favourites view
  if(state.open===game)renderLedger();
  toast(now?`★ <b>${esc(game.name)}</b> added to favourites`:`Removed <b>${esc(game.name)}</b> from favourites`);
}
function markOpened(game){
  // optimistic local update so a switch to Recent reflects it at once
  state.recentGames=[game.id,...state.recentGames.filter(x=>x!==game.id)];
  window.lib.noteOpened(game.id).then(list=>{state.recentGames=list;if(state.view==="recent")paint();});
}

/* ─────────────────────────────── TAGS ──────────────────────────────────── */
async function saveTags(game,tags){
  const stored=await window.lib.setTags(game.id,tags);   // backend trims/dedupes
  if(stored&&stored.length)state.tags.set(game.id,stored);else state.tags.delete(game.id);
  const rec=cards.get(game.id);if(rec){rec.tagKey=undefined;updateCard(rec,game);}
  paint();                                               // a tag filter may be active
  if(state.open===game){renderLedger();$("#tagInput")?.focus();}  // keep typing more tags
}
function addTag(game,raw){
  const t=String(raw).trim();if(!t)return;
  const cur=tagsFor(game.id);
  if(cur.some(x=>x.toLowerCase()===t.toLowerCase()))return;   // already tagged
  saveTags(game,[...cur,t]);
}
function removeTag(game,tag){saveTags(game,tagsFor(game.id).filter(x=>x!==tag));}
function searchTag(tag){
  state.filter="#"+tag;
  const s=$("#search");if(s)s.value=state.filter;
  closeLedger();paint();
  toast(`Showing books tagged <b>${esc(tag)}</b>`);
}

/* ─────────────────────────────── THEMES ────────────────────────────────── */
function setTheme(id){
  state.theme=id;applyTheme(id);
  window.lib.saveConfig({theme:id});
  for(const b of document.querySelectorAll(".theme-row"))b.classList.toggle("on",b.dataset.theme===id);
}
// A dropdown of swatches — clicking previews immediately; stays open so it's
// easy to flip between options and compare. Closes on outside click / Escape.
function toggleThemePanel(anchor){
  if($(".themepanel")){$(".themepanel").remove();return;}
  const panel=document.createElement("div");panel.className="menu themepanel";
  const r=anchor.getBoundingClientRect();
  panel.style.left=`${Math.min(r.left,innerWidth-300)}px`;
  panel.style.top=`${r.bottom+4}px`;
  panel.innerHTML=`<div class="tf-head">Accent color</div>`+
    THEMES.map(t=>`
      <button class="theme-row${t.id===state.theme?" on":""}" data-theme="${t.id}">
        <span class="theme-swatch" style="background:${t.wood};--sw-accent:${t.brass}"></span>
        <span class="theme-row-text">
          <span class="theme-row-name">${esc(t.name)}</span>
          <span class="theme-row-desc">${esc(t.desc)}</span>
        </span>
        <span class="theme-row-check">✓</span>
      </button>`).join("");
  document.body.appendChild(panel);
  panel.addEventListener("click",e=>{
    const row=e.target.closest("[data-theme]");if(row)setTheme(row.dataset.theme);
  });
  const dismiss=(ev)=>{if(panel.contains(ev.target)||ev.target===anchor)return;panel.remove();document.removeEventListener("pointerdown",dismiss,true);};
  setTimeout(()=>document.addEventListener("pointerdown",dismiss,true),0);
}

// Every tag in use, with how many games carry it, sorted alphabetically.
function allTags(){
  const counts=new Map();
  for(const g of state.games)for(const t of tagsFor(g.id))counts.set(t,(counts.get(t)||0)+1);
  return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true,sensitivity:"base"}));
}
function updateTagFilterButton(){
  const b=$("#tagFilter");if(!b)return;
  const n=state.excludedTags.size;
  b.textContent=n?`Tags · ${n} hidden ▾`:"Tags ▾";
  b.classList.toggle("deliberate",n>0);
}
// A dropdown of checkboxes — unchecking a tag hides its books for this session.
function toggleTagFilterPanel(anchor){
  if($(".tagfilter")){$(".tagfilter").remove();return;}
  const tags=allTags();
  const panel=document.createElement("div");panel.className="menu tagfilter";
  const r=anchor.getBoundingClientRect();
  panel.style.left=`${Math.min(r.left,innerWidth-268)}px`;
  panel.style.top=`${r.bottom+4}px`;
  if(!tags.length){
    panel.innerHTML=`<div class="tf-empty">No tags yet.<br>Add tags from a book's Ledger, then hide or show them here.</div>`;
  }else{
    panel.innerHTML=`<div class="tf-head">Show books tagged…</div><div class="tf-list">`+
      tags.map(([t,n])=>`<label class="tf-row${isWarnTag(t)?" warn":""}"><input type="checkbox" data-xtag="${esc(t)}" ${state.excludedTags.has(t)?"":"checked"}><span class="tf-name">${isWarnTag(t)?WARN_ICON:""}${esc(t)}</span><span class="tf-count">${n}</span></label>`).join("")+
      `</div>`+(state.excludedTags.size?`<button class="tf-reset" data-tfreset>Show all again</button>`:"");
  }
  document.body.appendChild(panel);
  panel.addEventListener("change",e=>{
    const cb=e.target.closest("[data-xtag]");if(!cb)return;
    if(cb.checked)state.excludedTags.delete(cb.dataset.xtag);else state.excludedTags.add(cb.dataset.xtag);
    updateTagFilterButton();paint();
  });
  panel.addEventListener("click",e=>{
    if(e.target.closest("[data-tfreset]")){state.excludedTags.clear();panel.remove();updateTagFilterButton();paint();}
  });
  const dismiss=(ev)=>{if(panel.contains(ev.target)||ev.target===anchor)return;panel.remove();document.removeEventListener("pointerdown",dismiss,true);};
  setTimeout(()=>document.addEventListener("pointerdown",dismiss,true),0);
}

/* ─────────────────────────── LEDGER (modal) ─────────────────────────────── */
function openLedger(game){state.open=game;state.expanded=new Set();markOpened(game);renderLedger();}
function closeLedger(){state.open=null;$("#scrim")?.remove();removeThumbZoom();}

// Magnifier for the ledger's small cover thumbnail — hovering it shows the
// cached cover (already ~420px wide, far sharper than the 96px thumb) in a
// floating panel positioned beside the thumb, clamped to stay on-screen.
function showThumbZoom(anchorEl,url){
  removeThumbZoom();
  const prev=document.createElement("div");prev.className="thumb-zoom";
  prev.innerHTML=`<img src="${esc(url)}" alt="">`;
  document.body.appendChild(prev);
  const position=()=>{
    const a=anchorEl.getBoundingClientRect();const p=prev.getBoundingClientRect();
    let left=a.right+14;
    if(left+p.width>innerWidth-12)left=a.left-14-p.width;
    left=Math.max(12,left);
    let top=Math.min(a.top,innerHeight-12-p.height);top=Math.max(12,top);
    prev.style.left=`${left}px`;prev.style.top=`${top}px`;
  };
  const img=prev.querySelector("img");
  if(img.complete)position();else img.addEventListener("load",position,{once:true});
  requestAnimationFrame(position);   // catches the layout-ready case even if `load` already fired from cache
}
function removeThumbZoom(){$(".thumb-zoom")?.remove();}

function renderLedger(){
  $("#scrim")?.remove();removeThumbZoom();const g=state.open;if(!g)return;
  const scrim=document.createElement("div");scrim.className="scrim";scrim.id="scrim";
  const thumb=g.cachedCover?`<img src="${esc(g.cachedCover)}" alt="">`:`<div class="mini">${esc(g.name)}</div>`;
  const fav=state.favorites.has(g.id);
  const meta=[`${fmtInt(g.counts.total)} files`,`${g.counts.pdf} pdf`,g.counts.image?`${g.counts.image} image`:null,
    g.counts.text?`${g.counts.text} text`:null,fmtBytes(g.bytes)].filter(Boolean).join(" · ");
  scrim.innerHTML=`
    <div class="ledger" role="dialog" aria-label="${esc(g.name)}">
      <div class="ledger-head">
        <div class="ledger-thumb${g.cachedCover?" zoomable":""}" id="ledgerThumb" title="${g.cachedCover?"Hover to magnify":""}">${thumb}</div>
        <div class="ledger-info">
          <div class="ledger-title">${esc(g.name)}</div>
          <div class="ledger-meta">${meta}</div>
          <div class="ledger-tags" id="ledgerTags">
            ${tagsFor(g.id).map(t=>`<span class="tagchip${isWarnTag(t)?" warn":""}"><button class="tagchip-label" data-search-tag="${esc(t)}" title="Search this tag">${isWarnTag(t)?WARN_ICON:""}${esc(t)}</button><button class="tagchip-x" data-remove-tag="${esc(t)}" title="Remove tag" aria-label="Remove tag">×</button></span>`).join("")}
            <input class="tag-input" id="tagInput" placeholder="+ tag" spellcheck="false" maxlength="40" autocomplete="off">
          </div>
          <div class="ledger-acts">
            ${g.cover?`<button class="rail-btn pri" data-open="${esc(g.cover.path)}">Open main book</button>`:""}
            <button class="rail-btn" data-open="${esc(g.path)}">Open folder</button>
            <button class="rail-btn${fav?" pri":""}" id="favBtn">${fav?"★ Favourited":"☆ Favourite"}</button>
            <button class="rail-btn" id="pickCover">Set cover…</button>
            <button class="rail-btn ghost" id="closeLedger">Close</button>
          </div>
        </div>
      </div>
      <div class="ledger-body">${g.tree.length?treeHtml(g.tree,0):'<div class="ledger-note">This folder is empty.</div>'}
        ${g.truncated?'<div class="ledger-note">Listing truncated — this folder blew past the node cap.</div>':""}
      </div>
    </div>`;
  document.body.appendChild(scrim);
  scrim.addEventListener("click",e=>{if(e.target===scrim)closeLedger();});
  $("#closeLedger",scrim).onclick=closeLedger;
  $("#favBtn",scrim).onclick=()=>toggleFav(g);
  $("#pickCover",scrim).onclick=()=>chooseCover(g);

  if(g.cachedCover){
    const thumbEl=$("#ledgerThumb",scrim);
    thumbEl.addEventListener("pointerenter",()=>showThumbZoom(thumbEl,g.cachedCover));
    thumbEl.addEventListener("pointerleave",removeThumbZoom);
  }

  // tags: add on Enter/comma, remove via ×, click a chip to search that tag
  const tagInput=$("#tagInput",scrim);
  tagInput.addEventListener("keydown",e=>{
    if(e.key==="Enter"||e.key===","){e.preventDefault();const v=tagInput.value;tagInput.value="";addTag(g,v);}
    else if(e.key==="Backspace"&&!tagInput.value){const cur=tagsFor(g.id);if(cur.length)removeTag(g,cur[cur.length-1]);}
  });
  tagInput.addEventListener("blur",()=>{if(tagInput.value.trim())addTag(g,tagInput.value);});
  $("#ledgerTags",scrim).addEventListener("click",e=>{
    const rm=e.target.closest("[data-remove-tag]");if(rm){removeTag(g,rm.dataset.removeTag);return;}
    const s=e.target.closest("[data-search-tag]");if(s){searchTag(s.dataset.searchTag);}
  });

  scrim.addEventListener("click",e=>{
    const openBtn=e.target.closest("[data-open]");if(openBtn){launch(openBtn.dataset.open);return;}
    const row=e.target.closest(".node");if(!row)return;
    if(row.classList.contains("dir-row")){
      const k=row.dataset.path;state.expanded.has(k)?state.expanded.delete(k):state.expanded.add(k);
      // re-render preserves scroll because only the body innerHTML changes
      const sc=$(".ledger-body",scrim).scrollTop;renderLedger();$(".ledger-body")?.scrollTo(0,sc);
    }else launch(row.dataset.path);
  });
}
function treeHtml(nodes){
  const dirs=nodes.filter(n=>n.type==="dir"), files=nodes.filter(n=>n.type==="file");
  const cmp=(a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:"base"});
  dirs.sort(cmp);files.sort(cmp);
  return[...dirs,...files].map(n=>{
    if(n.type==="dir"){const open=state.expanded.has(n.path);
      return`<div class="node dir-row${open?" open":""}" data-path="${esc(n.path)}">
        <span class="chev">${CHEV_ICON}</span><span class="tag dir">dir</span>
        <span class="nm">${esc(n.name)}</span><span class="sz">${fmtInt(n.children.length)}</span></div>
        ${open?`<div class="kids">${treeHtml(n.children)}</div>`:""}`;}
    return`<div class="node file-row" data-path="${esc(n.path)}">
      <span class="tag ${esc(n.kind)}">${esc((n.ext||"").replace(".","")||"file")}</span>
      <span class="nm">${esc(n.name)}</span><span class="sz">${fmtBytes(n.size)}</span></div>`;
  }).join("");
}

/* ─────────────────────────────── ACTIONS ───────────────────────────────── */
async function launch(absPath){const err=await window.lib.openPath(absPath);
  if(err)toast(`Windows could not open that — ${err}`);else toast(`Opening <b>${esc(absPath.split("\\").pop())}</b>`);}

// Force a fresh cover render, but never leave the game worse off than before:
// the previous cached cover stays the source of truth until a new one
// actually succeeds. A mis-click on "Re-render cover" (or a bad page pick)
// can't silently destroy a manually-curated cover with no way back.
async function reRenderCover(game,rec){
  const prevCover=game.cachedCover;
  coverDone.add(game.id);                 // keep the lazy scroll pipeline from also grabbing this one
  await window.lib.clearCover(game.id);
  game.cachedCover=null;
  if(rec)updateCard(rec,game);
  try{
    const url=await buildCover(game);
    game.cachedCover=url||prevCover;
    if(!url&&prevCover)toast("Couldn't re-render — kept the previous cover.");
  }catch(e){
    console.warn("[cover] re-render failed",game.name,e);
    game.cachedCover=prevCover;
    if(prevCover)toast("Couldn't re-render — kept the previous cover.");
  }
  if(rec)updateCard(rec,game);
  if(state.open===game)renderLedger();
}

async function chooseCover(game){
  // Native picker defaults to this game's own folder so covers stay in-folder.
  const picked=await window.lib.pickCoverFile(game.path);
  if(!picked)return;
  const isPdf=/\.pdf$/i.test(picked);
  let page=1;
  if(isPdf){
    const a=await askPage(game.coverPage||1);   // in-app prompt — window.prompt() is unsupported in Electron
    if(a===null)return;                          // cancelled
    page=a;
  }
  await window.lib.setCoverOverride(game.id,picked,page);
  game.cover={kind:isPdf?"pdf":"image",path:picked};game.coverPage=page;
  const inFolder=picked.toLowerCase().startsWith(game.path.toLowerCase()+"\\");
  toast(`Cover set to <b>${esc(picked.split("\\").pop())}</b>${isPdf?` (p.${page})`:""}${inFolder?"":" — outside this folder"} · re-rendering…`);
  await reRenderCover(game,cards.get(game.id));
}

// Small in-app numeric prompt (Electron has no window.prompt). Resolves to a
// positive integer, or null if cancelled.
function askPage(initial){
  return new Promise(resolve=>{
    $(".askbox")?.remove();
    const box=document.createElement("div");box.className="askbox";
    box.innerHTML=`
      <div class="askbox-panel" role="dialog" aria-label="Cover page">
        <div class="askbox-title">Which page is the cover?</div>
        <input class="askbox-input" type="number" min="1" step="1" value="${initial||1}">
        <div class="askbox-acts">
          <button class="rail-btn" data-ask="cancel">Cancel</button>
          <button class="rail-btn pri" data-ask="ok">Use page</button>
        </div>
      </div>`;
    document.body.appendChild(box);
    const input=$(".askbox-input",box);
    input.focus();input.select();
    const done=(val)=>{box.remove();resolve(val);};
    const commit=()=>{const n=Math.max(1,parseInt(input.value,10)||1);done(n);};
    box.addEventListener("click",e=>{
      if(e.target===box)return done(null);
      const a=e.target.closest("[data-ask]")?.dataset.ask;
      if(a==="ok")commit();else if(a==="cancel")done(null);
    });
    input.addEventListener("keydown",e=>{
      if(e.key==="Enter"){e.preventDefault();commit();}
      else if(e.key==="Escape"){e.preventDefault();done(null);}
    });
  });
}
function showMenu(x,y,game){
  $(".menu")?.remove();
  const menu=document.createElement("div");menu.className="menu";
  menu.style.left=`${Math.min(x,innerWidth-210)}px`;menu.style.top=`${Math.min(y,innerHeight-210)}px`;
  const fav=state.favorites.has(game.id);
  menu.innerHTML=`<button data-act="open">Open contents</button>
    ${game.cover?'<button data-act="main">Open main book</button>':""}
    <button data-act="explorer">Show in Explorer</button><hr>
    <button data-act="fav">${fav?"Remove from favourites":"Add to favourites"}</button>
    <button data-act="cover">Set cover…</button>
    <button data-act="redo">Re-render cover</button>`;
  document.body.appendChild(menu);
  menu.addEventListener("click",async e=>{const act=e.target.closest("[data-act]")?.dataset.act;menu.remove();
    if(act==="open")openLedger(game);
    else if(act==="main"){markOpened(game);launch(game.cover.path);}
    else if(act==="explorer"){window.lib.showInFolder(game.path);toast("Revealed in Explorer");}
    else if(act==="fav")toggleFav(game);
    else if(act==="cover")chooseCover(game);
    else if(act==="redo"){toast("Re-rendering cover…");await reRenderCover(game,cards.get(game.id));}});
  // Dismiss only on a pointerdown OUTSIDE the menu. The previous version fired on
  // any pointerdown — including one on a menu item — removing the menu before its
  // click could register, so no menu action ever ran.
  const dismiss=(ev)=>{if(menu.contains(ev.target))return;menu.remove();document.removeEventListener("pointerdown",dismiss,true);};
  setTimeout(()=>document.addEventListener("pointerdown",dismiss,true),0);
}
let toastT;function toast(html){$(".toast")?.remove();const t=document.createElement("div");t.className="toast";t.innerHTML=html;
  document.body.appendChild(t);clearTimeout(toastT);toastT=setTimeout(()=>t.remove(),2200);}

document.addEventListener("keydown",e=>{
  if(e.key==="Escape"){$(".menu")?.remove();closeLedger();}
  if(e.key==="/"&&document.activeElement!==$("#search")){e.preventDefault();$("#search")?.focus();}});

/* ─────────────────────────────── BACKEND WIRING ─────────────────────────── */
let paintTimer=null;
function schedulePaint(){if(paintTimer)return;paintTimer=setTimeout(()=>{paintTimer=null;paint();},120);}

// Rescan always bypasses the cache and re-walks every folder from scratch —
// that's its whole point — so the backend rebuilds and reports every single
// game every time, whether or not anything on disk actually differs. A
// deliberate Rescan earns a real confirmation of that work either way: the
// user asked for the slow, thorough path, so tell them what it found.
//
// The quiet background revalidation that runs on every launch is the
// opposite case: it's silent by design and stays silent here too, UNLESS it
// actually found something — that's the one moment worth interrupting for,
// since it's genuinely new information the user didn't ask to see.
function scanChangeSummary(rebuilt,removed){
  const parts=[];
  if(rebuilt)parts.push(`${fmtInt(rebuilt)} ${rebuilt===1?"game":"games"} updated`);
  if(removed.length)parts.push(`${fmtInt(removed.length)} removed`);
  return parts.join(" · ");
}
let lastScanForced=false;

window.lib.onLibraryCached(({games})=>{               // whole library, instantly, from the cached index
  state.games=games;state.byId=new Map(games.map(g=>[g.id,g]));state.error=null;paint();});
window.lib.onGameScanned(game=>{                      // only games that changed on disk
  const prev=state.byId.get(game.id);
  if(prev)state.games[state.games.indexOf(prev)]=game;else state.games.push(game);
  state.byId.set(game.id,game);coverDone.delete(game.id);schedulePaint();});
window.lib.onScanDone(({count,rebuilt,removed})=>{
  removed=removed||[];
  if(removed.length){const gone=new Set(removed);
    state.games=state.games.filter(g=>!gone.has(g.id));for(const id of gone)state.byId.delete(id);}
  state.scanning=false;paint();scheduleIdlePrecache();
  if(lastScanForced){
    if(count>0)toast(`<b>${fmtInt(count)}</b> ${count===1?"game":"games"} catalogued.`);
  }else if(rebuilt>0||removed.length){
    toast(scanChangeSummary(rebuilt,removed));
  }
});

async function startScan(rootPath,force){
  state.scanning=true;state.error=null;lastScanForced=!!force;
  if(force){state.games=[];state.byId.clear();for(const rec of cards.values())rec.el.remove();
    cards.clear();coverQueue.length=0;coverDone.clear();queued.clear();}
  paint();
  const res=await window.lib.scanLibrary(rootPath,force);
  state.scanning=false;
  if(res&&!res.ok&&res.error!=="superseded"){state.error=res.error;paint();}else paint();
}

(async function boot(){
  const cfg=await window.lib.getConfig();
  state.sort=cfg.sort||"name";
  state.favorites=new Set(cfg.favorites||[]);
  state.recentGames=cfg.recentGames||[];
  state.tags=new Map(Object.entries(cfg.tags||{}));
  state.cardSize=Math.min(CARD_SIZE_MAX,Math.max(CARD_SIZE_MIN,cfg.cardSize||178));
  document.documentElement.style.setProperty("--card-min",`${state.cardSize}px`);
  state.theme=THEMES.some(t=>t.id===cfg.theme)?cfg.theme:"archive";
  applyTheme(state.theme);
  mountChrome();paint();
  startScan(cfg.root,false);
})();
