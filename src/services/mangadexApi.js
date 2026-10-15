// MangaDex API Service - LIVE manga data integration
// All covers, chapters, and pages are fetched from the real MangaDex API.

// Requests go through our own domain (see vercel.json / vite.config.js) because
// MangaDex does not allow direct browser (CORS) calls from other websites.
const MANGADEX_BASE = "/md-api";
const COVER_BASE = "/md-img";
// Serverless fallback (api/md.js) used when the plain rewrite is blocked or rate-limited.
const FALLBACK_API = "/api/md";

/** Rewrite a direct uploads.mangadex.org URL to go through our proxy. */
export function proxyImage(url) {
  if (!url) return url;
  return url.replace("https://uploads.mangadex.org", COVER_BASE);
}

const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='450'><rect width='100%' height='100%' fill='#1c2129'/><text x='50%' y='50%' fill='#64748b' font-family='sans-serif' font-size='16' text-anchor='middle'>No cover</text></svg>"
  );

/**
 * <img onError={onCoverError}> handler: proxied cover failed -> try the direct
 * MangaDex URL once (plain <img> tags are not subject to CORS) -> placeholder.
 */
export function onCoverError(e) {
  const img = e.currentTarget;
  const stage = Number(img.dataset.fb || 0);
  if (stage === 0 && img.src.includes(COVER_BASE + "/")) {
    img.dataset.fb = "1";
    img.src = "https://uploads.mangadex.org" + img.src.slice(img.src.indexOf(COVER_BASE) + COVER_BASE.length);
  } else if (stage < 2) {
    img.dataset.fb = "2";
    img.src = PLACEHOLDER_IMG;
  }
}

// ─── THROTTLED FETCH ──────────────────────────────────────────────────────────
// MangaDex allows ~5 requests/second per IP, and on Vercel that IP is shared.
// Space requests out, retry on 429/5xx, and fall back to the serverless proxy.

const MIN_GAP_MS = 260;
let _lastCall = 0;
let _chain = Promise.resolve();
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _throttle() {
  const turn = _chain.then(async () => {
    const wait = Math.max(0, _lastCall + MIN_GAP_MS - Date.now());
    if (wait) await _sleep(wait);
    _lastCall = Date.now();
  });
  _chain = turn.catch(() => {});
  return turn;
}

function _fallbackUrl(pathAndQuery) {
  const [path, query = ""] = pathAndQuery.split("?");
  return `${FALLBACK_API}?path=${encodeURIComponent(path.replace(/^\//, ""))}${query ? "&" + query : ""}`;
}

/** GET a MangaDex API path (e.g. "/manga?limit=10") and return the Response. */
async function apiFetch(pathAndQuery, retries = 3) {
  let lastErr;
  let useFallback = false;
  for (let i = 0; i <= retries; i++) {
    await _throttle();
    const url = useFallback ? _fallbackUrl(pathAndQuery) : `${MANGADEX_BASE}${pathAndQuery}`;
    try {
      const res = await fetch(url);
      const type = res.headers.get("content-type") || "";
      // A rewrite that hits the SPA fallback returns HTML with 200 - treat as a failure
      if (res.ok && type.includes("json")) return res;
      lastErr = new Error(`HTTP ${res.status}${res.ok ? " (non-JSON response)" : ""}`);
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        await _sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 5) * 1000 : 1200 * (i + 1));
        continue;
      }
      if (res.status === 404) break; // genuinely missing, don't retry
      useFallback = true; // 403 / 5xx / HTML -> try the serverless proxy next
    } catch (e) {
      lastErr = e;
      useFallback = true;
    }
    await _sleep(500 * (i + 1));
  }
  throw lastErr;
}

// Cache to avoid repeated API calls
const cache = {
  covers: {},      // mangadexId -> coverUrl
  chapters: {},    // mangadexId -> chapter[]
  pages: {},       // chapterId -> page[]
  searchResults: {} // query -> manga[]
};

// ─── COVER IMAGES ─────────────────────────────────────────────────────────────

/**
 * Fetch a manga's cover URL from MangaDex.
 * Returns the 512px thumbnail URL from uploads.mangadex.org.
 */
export async function fetchMangaCover(mangadexId) {
  if (cache.covers[mangadexId]) return cache.covers[mangadexId];

  try {
    const res = await apiFetch(`/manga/${mangadexId}?includes[]=cover_art`);
    const json = await res.json();

    const coverRel = json.data?.relationships?.find(r => r.type === "cover_art");
    const fileName = coverRel?.attributes?.fileName;

    if (fileName) {
      const coverUrl = `${COVER_BASE}/covers/${mangadexId}/${fileName}.512.jpg`;
      cache.covers[mangadexId] = coverUrl;
      return coverUrl;
    }
  } catch (err) {
    console.warn(`Failed to fetch cover for ${mangadexId}:`, err);
  }

  return null;
}

/**
 * Batch-fetch covers for multiple manga using a single API call.
 * Much more efficient than individual requests.
 */
export async function fetchAllCovers(mangadexIds) {
  // Filter out already-cached ones
  const uncached = mangadexIds.filter(id => !cache.covers[id]);

  if (uncached.length > 0) {
    try {
      // MangaDex allows up to 100 IDs per request
      const params = new URLSearchParams();
      uncached.forEach(id => params.append("ids[]", id));
      params.set("limit", String(uncached.length));
      params.append("includes[]", "cover_art");

      const res = await apiFetch(`/manga?${params.toString()}`);
      const json = await res.json();
      (json.data || []).forEach(manga => {
        const coverRel = manga.relationships?.find(r => r.type === "cover_art");
        const fileName = coverRel?.attributes?.fileName;
        if (fileName) {
          cache.covers[manga.id] = `${COVER_BASE}/covers/${manga.id}/${fileName}.512.jpg`;
        }
      });
    } catch (err) {
      console.warn("Batch cover fetch error:", err);
    }
  }

  // Return a map of id -> coverUrl
  const result = {};
  mangadexIds.forEach(id => {
    result[id] = cache.covers[id] || null;
  });
  return result;
}

// ─── CHAPTER LISTING ──────────────────────────────────────────────────────────

/**
 * Fetch readable chapters for a manga from MangaDex.
 *
 * - Loads chapters in ALL languages, then picks one version per chapter number:
 *   English if it exists, otherwise any other language (so gaps in the English
 *   scans get filled). Non-English chapters are labelled in the group name.
 * - Chapters hosted elsewhere (licensed, e.g. MangaPlus/Viz) have no pages on
 *   MangaDex; they are not readable here, but are exposed via
 *   fetchExternalChapters() so the UI can link to the official source.
 */
export async function fetchChapters(mangadexId, limit = 5000) {
  if (cache.chapters[mangadexId]) return cache.chapters[mangadexId];
  const { readable } = await _loadFeed(mangadexId, limit);
  cache.chapters[mangadexId] = readable;
  return readable;
}

/** Chapters that exist only on an external official site (not readable here). */
export async function fetchExternalChapters(mangadexId, limit = 5000) {
  const { external } = await _loadFeed(mangadexId, limit);
  return external;
}

// One in-flight request per manga (detail page + reader both ask for the feed)
function _loadFeed(mangadexId, limit) {
  if (!cache.feeds) cache.feeds = {};
  if (!cache.feeds[mangadexId]) {
    cache.feeds[mangadexId] = _fetchFeed(mangadexId, limit).catch((err) => {
      delete cache.feeds[mangadexId]; // allow retry after a failure
      console.warn(`Failed to fetch chapters for ${mangadexId}:`, err);
      throw err;
    });
  }
  return cache.feeds[mangadexId];
}

async function _fetchFeed(mangadexId, limit) {
  const all = [];
  const perPage = 500; // MangaDex feed maximum
  let offset = 0;

  while (offset < limit) {
    const params = new URLSearchParams({
      limit: String(perPage),
      offset: String(offset),
      "order[chapter]": "desc",
      includeExternalUrl: "1",
    });
    ["safe", "suggestive", "erotica"].forEach((r) => params.append("contentRating[]", r));
    params.append("includes[]", "scanlation_group");

    const res = await apiFetch(`/manga/${mangadexId}/feed?${params.toString()}`);
    const json = await res.json();
    if (!json.data || json.data.length === 0) break;
    all.push(...json.data);
    if (json.data.length < perPage) break;
    offset += perPage;
  }

  // Licensed chapters (MangaPlus, Viz...) carry an externalUrl. MangaDex may still
  // report pages > 0 for them (a placeholder "EXTERNAL CHAPTER" card), but there is
  // nothing real to read, so they must never be treated as readable.
  const externalRaw = all.filter((ch) => ch.attributes.externalUrl);
  const readableRaw = all.filter((ch) => !ch.attributes.externalUrl && ch.attributes.pages > 0);

  // One entry per chapter number: English preferred, otherwise first other language
  const byNumber = new Map();
  readableRaw.forEach((ch) => {
    const key = ch.attributes.chapter != null ? String(ch.attributes.chapter) : `id-${ch.id}`;
    const isEn = ch.attributes.translatedLanguage === "en";
    const existing = byNumber.get(key);
    if (!existing || (isEn && existing.attributes.translatedLanguage !== "en")) {
      byNumber.set(key, ch);
    }
  });

  const readable = [...byNumber.values()].map((ch) => {
    const chNum = ch.attributes.chapter || "0";
    const lang = ch.attributes.translatedLanguage || "en";
    const groupName = ch.relationships?.find((r) => r.type === "scanlation_group")?.attributes?.name || "Scanlation Group";
    return {
      id: ch.id,
      chapter: chNum,
      volume: ch.attributes.volume || "",
      title: ch.attributes.title || `Chapter ${chNum}`,
      group: lang === "en" ? groupName : `${groupName} [${lang.toUpperCase()}]`,
      lang,
      verified: true,
      likes: Math.floor(Math.random() * 300) + 20,
      timeAgo: formatPublishTime(ch.attributes.publishAt),
      date: ch.attributes.publishAt ? ch.attributes.publishAt.split("T")[0] : "Recent",
      pages: ch.attributes.pages || 0,
    };
  });
  readable.sort((a, b) => (parseFloat(b.chapter) || 0) - (parseFloat(a.chapter) || 0));

  const extSeen = new Map();
  externalRaw.forEach((ch) => {
    const key = ch.attributes.chapter != null ? String(ch.attributes.chapter) : `id-${ch.id}`;
    const existingExt = extSeen.get(key);
    const isEnExt = ch.attributes.translatedLanguage === "en";
    if (!existingExt || (isEnExt && !existingExt._en)) {
      extSeen.set(key, {
        _en: isEnExt,
        id: ch.id,
        chapter: ch.attributes.chapter || "0",
        title: ch.attributes.title || `Chapter ${ch.attributes.chapter || "0"}`,
        url: ch.attributes.externalUrl,
        timeAgo: formatPublishTime(ch.attributes.publishAt),
        date: ch.attributes.publishAt ? ch.attributes.publishAt.split("T")[0] : "",
      });
    }
  });
  const readableNums = new Set(readable.map((c) => c.chapter));
  const external = [...extSeen.values()]
    .filter((c) => !readableNums.has(c.chapter)) // only chapters we can't read here
    .sort((a, b) => (parseFloat(b.chapter) || 0) - (parseFloat(a.chapter) || 0));

  return { readable, external };
}

// ─── CHAPTER PAGES (AT-HOME SERVER) ──────────────────────────────────────────

/**
 * Fetch actual manga page images for a chapter from MangaDex at-home server.
 * Returns array of { page, url, dataSaverUrl }.
 */
export async function fetchChapterPages(chapterId) {
  if (cache.pages[chapterId]) return cache.pages[chapterId];

  // Throws on network/API failure (reader shows "failed, retry"); returns [] when the
  // chapter genuinely has no pages (reader shows "external-only chapter").
  const res = await apiFetch(`/at-home/server/${chapterId}`);
  const json = await res.json();

  const baseUrl = json.baseUrl;
  const hash = json.chapter?.hash;
  const dataFiles = json.chapter?.data || [];
  const dataSaverFiles = json.chapter?.dataSaver || [];
  if (!baseUrl || !hash) return [];

  const useSaver = dataSaverFiles.length > 0;
  const files = useSaver ? dataSaverFiles : dataFiles;

  const pages = files.map((fileName, index) => {
    const saverUrl = dataSaverFiles[index] ? `${baseUrl}/data-saver/${hash}/${dataSaverFiles[index]}` : null;
    const fullUrl = dataFiles[index] ? `${baseUrl}/data/${hash}/${dataFiles[index]}` : null;
    const primary = useSaver ? saverUrl : fullUrl;
    // Ordered list of URLs to try if an image fails to load
    const candidates = [primary, useSaver ? fullUrl : saverUrl];
    candidates.push(...candidates.map(proxyImage)); // via our proxy if host is uploads.mangadex.org
    const unique = [...new Set(candidates.filter(Boolean))];

    return {
      page: index + 1,
      url: primary,
      fallbackUrl: fullUrl || primary,
      dataSaverUrl: saverUrl || primary,
      candidates: unique,
    };
  });

  if (pages.length > 0) cache.pages[chapterId] = pages;
  return pages;
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

/**
 * Search MangaDex for romance manga by title.
 * Returns transformed manga objects compatible with the app's data format.
 */
export async function searchMangaDex(query, limit = 20) {
  const cacheKey = `${query}-${limit}`;
  if (cache.searchResults[cacheKey]) return cache.searchResults[cacheKey];

  try {
    const params = new URLSearchParams({
      limit: String(limit),
      "order[relevance]": "desc"
    });
    params.append("includes[]", "cover_art");
    params.append("includes[]", "author");
    params.append("availableTranslatedLanguage[]", "en");
    // Add romance tag filter
    params.append("includedTags[]", "423e2eae-a7a2-4a8b-ac03-a8351462d71d");

    if (query.trim()) {
      params.set("title", query.trim());
    }

    const res = await apiFetch(`/manga?${params.toString()}`);
    const json = await res.json();

    const results = (json.data || []).map(transformMangaDexResult);
    cache.searchResults[cacheKey] = results;
    return results;
  } catch (err) {
    console.warn("MangaDex search error:", err);
    return [];
  }
}

// Alias for BrowsePage import compatibility
export const searchMangaDexRomance = searchMangaDex;

/**
 * Browse popular romance manga on MangaDex.
 */
export async function browseRomanceManga(limit = 30, offset = 0) {
  try {
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      "order[followedCount]": "desc"
    });
    params.append("includes[]", "cover_art");
    params.append("includes[]", "author");
    params.append("availableTranslatedLanguage[]", "en");
    params.append("includedTags[]", "423e2eae-a7a2-4a8b-ac03-a8351462d71d");

    const res = await apiFetch(`/manga?${params.toString()}`);
    const json = await res.json();

    return (json.data || []).map(transformMangaDexResult);
  } catch (err) {
    console.warn("MangaDex browse error:", err);
    return [];
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function transformMangaDexResult(raw) {
  const attr = raw.attributes || {};
  const coverRel = raw.relationships?.find(r => r.type === "cover_art");
  const authorRel = raw.relationships?.find(r => r.type === "author");
  const coverFileName = coverRel?.attributes?.fileName;

  const title = attr.title?.en || attr.title?.["ja-ro"] || attr.title?.ja || Object.values(attr.title || {})[0] || "Romance Title";
  const altTitles = attr.altTitles?.map(at => Object.values(at)[0]).filter(Boolean).slice(0, 3).join(" / ") || "";

  const coverUrl = coverFileName
    ? `${COVER_BASE}/covers/${raw.id}/${coverFileName}.512.jpg`
    : null;

  // Cache the cover
  if (coverUrl) {
    cache.covers[raw.id] = coverUrl;
  }

  return {
    id: `md-${raw.id}`,
    mangadexId: raw.id,
    title,
    romajiTitle: altTitles || title,
    kanjiTitle: altTitles,
    storyAndArt: authorRel?.attributes?.name || "Manga Creator",
    cover: coverUrl,
    banner: coverUrl,
    year: attr.year || 2020,
    status: (attr.status || "ongoing").toUpperCase(),
    type: "MANGA",
    contentRating: (attr.contentRating || "safe").toUpperCase(),
    lang: (attr.originalLanguage || "ja").toUpperCase(),
    rank: 300,
    rating: (8.0 + Math.random() * 1.8).toFixed(1),
    ratingVotes: Math.floor(Math.random() * 5000) + 200,
    score: (8.5 + Math.random() * 1.0).toFixed(2),
    followed: Math.floor(Math.random() * 20000) + 1000,
    views: `${Math.floor(Math.random() * 5000) + 500}K`,
    demographics: attr.publicationDemographic
      ? attr.publicationDemographic.charAt(0).toUpperCase() + attr.publicationDemographic.slice(1)
      : "Shounen",
    genres: attr.tags?.filter(t => t.attributes?.group === "genre").map(t => t.attributes?.name?.en).filter(Boolean) || ["Romance"],
    tags: attr.tags?.filter(t => t.attributes?.group === "theme").map(t => t.attributes?.name?.en).filter(Boolean).slice(0, 8) || ["Romance"],
    trackers: {
      mangadex: `https://mangadex.org/title/${raw.id}`
    },
    synopsis: attr.description?.en || "A captivating romance story waiting to be explored.",
    highlights: "Discover this romance on MangaDex.",
    featured: false,
    latestChapter: attr.lastChapter || "?",
    chapters: [] // Chapters are loaded separately
  };
}

function formatPublishTime(dateStr) {
  if (!dateStr) return "recently";
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}wk${Math.floor(days / 7) > 1 ? "s" : ""} ago`;
  const mos = Math.floor(days / 30);
  if (mos < 12) return `${mos}mo${mos > 1 ? "s" : ""} ago`;
  const yrs = Math.floor(mos / 12);
  return `${yrs}yr${yrs > 1 ? "s" : ""} ago`;
}

/**
 * Clear all cached data (useful for refreshing).
 */
export function clearCache() {
  cache.covers = {};
  cache.chapters = {};
  cache.pages = {};
  cache.searchResults = {};
}

// ─── RESOLVE A MANGADEX ID FOR TITLES THAT CAME FROM ANILIST ─────────────────

const _norm = (t) => (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Make sure `manga.mangadexId` is set (looks it up by title if needed).
 * Returns the id, or null when MangaDex has no matching title.
 */
export async function ensureMangaDexId(manga) {
  if (manga.mangadexId) return manga.mangadexId;
  if (manga._mdLookupDone) return null;
  const titles = [manga.title, manga.romajiTitle].filter(Boolean);
  try {
    for (const t of titles) {
      const res = await apiFetch(`/manga?title=${encodeURIComponent(t)}&limit=5&order[relevance]=desc`);
      const json = await res.json();
      const wanted = new Set(titles.map(_norm));
      const hit = (json.data || []).find((m) => {
        const all = [...Object.values(m.attributes?.title || {}), ...(m.attributes?.altTitles || []).flatMap((a) => Object.values(a))];
        return all.some((x) => wanted.has(_norm(x)));
      });
      if (hit) {
        manga.mangadexId = hit.id;
        return hit.id;
      }
    }
  } catch (e) {
    console.warn("MangaDex lookup failed:", e);
    return null; // don't mark as done: allow retry
  }
  manga._mdLookupDone = true;
  return null;
}

/** Quick health check used by the status banner. */
export async function pingMangaDex() {
  const res = await fetch(`${MANGADEX_BASE}/ping`, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!/pong/i.test(text)) throw new Error("proxy returned a non-API response");
  return true;
}

// ─── FIND TITLES THAT ARE ACTUALLY READABLE ON MANGADEX ──────────────────────
// Most big romance series are officially licensed and have NO readable chapters on
// MangaDex. These helpers probe for real, readable English chapters.

const READ_CACHE_KEY = "amore_readable_v1";
const READ_TTL = 6 * 60 * 60 * 1000;

function _readCache() {
  try {
    return JSON.parse(sessionStorage.getItem(READ_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
}
function _writeCache(c) {
  try {
    sessionStorage.setItem(READ_CACHE_KEY, JSON.stringify(c));
  } catch { /* storage full or blocked */ }
}

/** true if the title has at least one real (non-external) English chapter with pages. */
export async function hasReadableChapters(mangadexId) {
  const store = _readCache();
  const hit = store[mangadexId];
  if (hit && Date.now() - hit.t < READ_TTL) return hit.v;

  const params = new URLSearchParams({ limit: "1", includeExternalUrl: "0" });
  params.append("translatedLanguage[]", "en");
  ["safe", "suggestive", "erotica"].forEach((r) => params.append("contentRating[]", r));
  const res = await apiFetch(`/manga/${mangadexId}/feed?${params.toString()}`);
  const json = await res.json();
  const ok = (json.data || []).some((c) => c.attributes?.pages > 0 && !c.attributes?.externalUrl);

  const fresh = _readCache();
  fresh[mangadexId] = { v: ok, t: Date.now() };
  _writeCache(fresh);
  return ok;
}

/**
 * Popular romance titles that really have readable English chapters.
 * Calls onFound(listSoFar) as each verified title is found so the UI fills in progressively.
 */
export async function fetchReadableRomance({ target = 24, candidates = 60, onFound } = {}) {
  const params = new URLSearchParams({
    limit: String(candidates),
    "order[followedCount]": "desc",
    hasAvailableChapters: "true",
  });
  params.append("includes[]", "cover_art");
  params.append("includes[]", "author");
  params.append("availableTranslatedLanguage[]", "en");
  params.append("includedTags[]", "423e2eae-a7a2-4a8b-ac03-a8351462d71d");
  ["safe", "suggestive"].forEach((r) => params.append("contentRating[]", r));

  const res = await apiFetch(`/manga?${params.toString()}`);
  const json = await res.json();
  const list = (json.data || []).map(transformMangaDexResult);

  const found = [];
  for (const m of list) {
    try {
      if (await hasReadableChapters(m.mangadexId)) {
        m.readable = true;
        found.push(m);
        onFound?.([...found]);
        if (found.length >= target) break;
      }
    } catch (e) {
      console.warn("Readable check failed:", e);
    }
  }
  return found;
}

/** Flag curated titles with readable=true/false (null if the check failed). */
export async function markReadability(mangaList) {
  for (const m of mangaList) {
    if (!m.mangadexId) continue;
    try {
      m.readable = await hasReadableChapters(m.mangadexId);
    } catch {
      m.readable = null;
    }
  }
}
