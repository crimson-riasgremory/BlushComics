// MangaDex API Service - LIVE manga data integration
// All covers, chapters, and pages are fetched from the real MangaDex API.

// Requests go through our own domain (see vercel.json / vite.config.js) because
// MangaDex does not allow direct browser (CORS) calls from other websites.
const MANGADEX_BASE = "/md-api";
const COVER_BASE = "/md-img";

/** Rewrite a direct uploads.mangadex.org URL to go through our proxy. */
export function proxyImage(url) {
  if (!url) return url;
  return url.replace("https://uploads.mangadex.org", COVER_BASE);
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
    const res = await fetch(
      `${MANGADEX_BASE}/manga/${mangadexId}?includes[]=cover_art`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

      const res = await fetch(`${MANGADEX_BASE}/manga?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        (json.data || []).forEach(manga => {
          const coverRel = manga.relationships?.find(r => r.type === "cover_art");
          const fileName = coverRel?.attributes?.fileName;
          if (fileName) {
            cache.covers[manga.id] = `${COVER_BASE}/covers/${manga.id}/${fileName}.512.jpg`;
          }
        });
      }
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

    const res = await fetchWithRetry(`${MANGADEX_BASE}/manga/${mangadexId}/feed?${params.toString()}`);
    const json = await res.json();
    if (!json.data || json.data.length === 0) break;
    all.push(...json.data);
    if (json.data.length < perPage) break;
    offset += perPage;
  }

  const readableRaw = all.filter((ch) => ch.attributes.pages > 0);
  const externalRaw = all.filter((ch) => !(ch.attributes.pages > 0) && ch.attributes.externalUrl);

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
    if (!extSeen.has(key)) {
      extSeen.set(key, {
        id: ch.id,
        chapter: ch.attributes.chapter || "0",
        title: ch.attributes.title || `Chapter ${ch.attributes.chapter || "0"}`,
        url: ch.attributes.externalUrl,
      });
    }
  });
  const readableNums = new Set(readable.map((c) => c.chapter));
  const external = [...extSeen.values()]
    .filter((c) => !readableNums.has(c.chapter)) // only chapters we can't read here
    .sort((a, b) => (parseFloat(b.chapter) || 0) - (parseFloat(a.chapter) || 0));

  return { readable, external };
}

// Retry once on rate-limit (429) or server errors
async function fetchWithRetry(url, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
  }
  throw lastErr;
}

// ─── CHAPTER PAGES (AT-HOME SERVER) ──────────────────────────────────────────

/**
 * Fetch actual manga page images for a chapter from MangaDex at-home server.
 * Returns array of { page, url, dataSaverUrl }.
 */
export async function fetchChapterPages(chapterId) {
  if (cache.pages[chapterId]) return cache.pages[chapterId];

  try {
    const res = await fetchWithRetry(`${MANGADEX_BASE}/at-home/server/${chapterId}`);
    const json = await res.json();

    const baseUrl = json.baseUrl;
    const hash = json.chapter?.hash;
    const dataFiles = json.chapter?.data || [];
    const dataSaverFiles = json.chapter?.dataSaver || [];

    // Use data-saver as primary since it's more reliable on the CDN
    // and fall back to full quality
    const pages = (dataSaverFiles.length > 0 ? dataSaverFiles : dataFiles).map((fileName, index) => {
      const isDataSaver = dataSaverFiles.length > 0;
      const primaryUrl = isDataSaver
        ? `${baseUrl}/data-saver/${hash}/${fileName}`
        : `${baseUrl}/data/${hash}/${fileName}`;
      const fallbackUrl = isDataSaver && dataFiles[index]
        ? `${baseUrl}/data/${hash}/${dataFiles[index]}`
        : primaryUrl;

      return {
        page: index + 1,
        url: primaryUrl,
        fallbackUrl: fallbackUrl,
        dataSaverUrl: dataSaverFiles[index]
          ? `${baseUrl}/data-saver/${hash}/${dataSaverFiles[index]}`
          : primaryUrl
      };
    });

    // If dataSaver is empty, try full data
    if (pages.length === 0 && dataFiles.length > 0) {
      const fullPages = dataFiles.map((fileName, index) => ({
        page: index + 1,
        url: `${baseUrl}/data/${hash}/${fileName}`,
        fallbackUrl: `${baseUrl}/data/${hash}/${fileName}`,
        dataSaverUrl: `${baseUrl}/data/${hash}/${fileName}`
      }));
      cache.pages[chapterId] = fullPages;
      return fullPages;
    }

    cache.pages[chapterId] = pages;
    return pages;
  } catch (err) {
    console.warn(`Failed to fetch pages for chapter ${chapterId}:`, err);
    return [];
  }
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

    const res = await fetch(`${MANGADEX_BASE}/manga?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

    const res = await fetch(`${MANGADEX_BASE}/manga?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
