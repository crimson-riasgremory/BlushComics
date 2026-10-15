// Comprehensive Romance Manga Masterpiece Database
// Curated exclusively for romance lovers with rich metadata.
// All covers and chapters are loaded LIVE from MangaDex API.

export const ROMANCE_GENRES = [
  "All Romance",
  "High School",
  "Wholesome / Fluff",
  "Sports Romance",
  "Slow Burn",
  "Friends to Lovers",
  "Enemies / Opposites Attract",
  "Rom-Com",
  "Slice of Life",
  "College / Adult",
  "Tearjerker / Drama",
  "Supernatural / Fantasy Romance"
];

export const ROMANCE_TROPES = [
  "Male Lead Falls in Love First",
  "Female Lead Falls in Love First",
  "Mutual Pining",
  "Love Confession",
  "Love Triangle",
  "Childhood Friends",
  "Opposites Attract",
  "Height Difference",
  "Sports & Romance",
  "Wholesome",
  "Adapted to Anime",
  "Co-living / Roommates",
  "Secret Relationship",
  "Popular x Shy",
  "Workplace Romance"
];

export const ROMANCE_DATABASE = [
  {
    id: "blue-box",
    mangadexId: "ed5dddc0-999d-4fd2-a702-9fef1ec2c955",
    title: "Blue Box",
    romajiTitle: "Ao no Hako",
    kanjiTitle: "アオのハコ / Ao no Hako",
    storyAndArt: "Miura Kouji",
    cover: "https://uploads.mangadex.org/covers/ed5dddc0-999d-4fd2-a702-9fef1ec2c955/584fde4c-a60b-433d-a0b5-8d113f8b75a9.jpg.512.jpg",
    banner: "https://uploads.mangadex.org/covers/ed5dddc0-999d-4fd2-a702-9fef1ec2c955/584fde4c-a60b-433d-a0b5-8d113f8b75a9.jpg",
    year: 2021,
    status: "ONGOING",
    type: "MANGA",
    contentRating: "SAFE",
    lang: "JA",
    rank: 473,
    rating: 9.4,
    ratingVotes: 890,
    score: 9.03,
    followed: 13031,
    views: "1.4M",
    demographics: "Shounen",
    genres: ["Comedy", "Drama", "Romance", "Slice of Life", "Sports"],
    tags: [
      "Adapted to Anime",
      "Male Lead Falls in Love First",
      "High School",
      "Sports & Romance",
      "Co-living",
      "Badminton & Basketball"
    ],
    trackers: {
      anilist: "https://anilist.co/manga/132182/Ao-no-Hako/",
      mal: "https://myanimelist.net/manga/135545/Ao_no_Hako",
      mangadex: "https://mangadex.org/title/ed5dddc0-999d-4fd2-a702-9fef1ec2c955"
    },
    synopsis: "Taiki Inomata is on the boys' badminton team at sports powerhouse Eimei Junior and Senior High. He is in love with fellow student and basketball player Chinatsu Kano, the older girl he trains alongside every morning in the gym. One day, Chinatsu's parents move abroad, and she ends up living at Taiki's house! As they live together, Taiki works hard to become a worthy partner both on the court and in love.",
    highlights: "The quintessential modern sports romance masterpiece with gentle realism and breathtaking romantic tension.",
    featured: true,
    latestChapter: 250,
    officialLinks: [{ site: "VIZ", url: "https://www.viz.com/blue-box" }],
    chapters: []
  }
];

// Serve curated covers/banners through our own domain (avoids MangaDex hotlink blocking)
ROMANCE_DATABASE.forEach((m) => {
  m.cover = m.cover?.replace("https://uploads.mangadex.org", "/md-img");
  m.banner = m.banner?.replace("https://uploads.mangadex.org", "/md-img");
});

// In-memory registry for manga discovered from MangaDex live search & browse
const dynamicMangaRegistry = new Map();

export function REGISTER_DYNAMIC_MANGA(manga) {
  if (!manga || !manga.id) return;
  dynamicMangaRegistry.set(manga.id, manga);
  if (manga.mangadexId) {
    dynamicMangaRegistry.set(manga.mangadexId, manga);
  }
}

export function GET_MANGA_BY_ID(id) {
  if (!id) return ROMANCE_DATABASE[0];
  // 1. Direct match in curated database by id
  const fromDb = ROMANCE_DATABASE.find(
    (m) => m.id === id || m.mangadexId === id || `md-${m.mangadexId}` === id
  );
  if (fromDb) return fromDb;

  // 2. Match in dynamic registry (from search/browse)
  if (dynamicMangaRegistry.has(id)) {
    return dynamicMangaRegistry.get(id);
  }

  // 3. If it looks like a MangaDex UUID, create a placeholder object that can be enriched
  const cleanId = /^al-/.test(id) ? null : id.replace(/^md-/, "");
  return {
    id: id,
    mangadexId: cleanId,
    title: "Loading Manga...",
    romajiTitle: "",
    storyAndArt: "Romance Artist",
    cover: null,
    rating: 9.0,
    genres: ["Romance"],
    tags: ["Romance Manga"],
    synopsis: "Fetching details from MangaDex...",
    chapters: []
  };
}

/**
 * Refresh curated entries (covers, banners, official links) from AniList so thumbnails
 * keep working even if MangaDex or the proxy is down. Mutates in place; returns true
 * if anything changed.
 */
export async function hydrateCuratedFromAniList(lookup) {
  const results = await lookup(ROMANCE_DATABASE.map((m) => m.romajiTitle || m.title));
  let changed = false;
  results.forEach((r, i) => {
    if (!r) return;
    const m = ROMANCE_DATABASE[i];
    if (r.cover) { m.cover = r.cover; changed = true; }
    if (r.banner) m.banner = r.banner;
    m.officialLinks = r.officialLinks;
    m.anilistId = r.anilistId;
  });
  return changed;
}
