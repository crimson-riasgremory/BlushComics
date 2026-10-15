import React, { useEffect, useState } from "react";
import { RomanceProvider, useRomance } from "./context/RomanceContext";
import Header from "./components/Header";
import Footer from "./components/Footer";
import SettingsModal from "./components/SettingsModal";
import ShortcutsModal from "./components/ShortcutsModal";
import MangaDetailPage from "./pages/MangaDetailPage";
import ReaderPage from "./pages/ReaderPage";
import StatusBanner from "./components/StatusBanner";
import { hydrateCuratedFromAniList } from "./data/romanceMangaDatabase";
import { lookupAniListByTitles } from "./services/anilistApi";

function MainApp() {
  const { route } = useRomance();
  const isReaderView = route.view === "reader";

  // Refresh cover / banner / official links from AniList, then re-render
  const [, setTick] = useState(0);
  useEffect(() => {
    hydrateCuratedFromAniList(lookupAniListByTitles)
      .then((changed) => changed && setTick((t) => t + 1))
      .catch((e) => console.warn("AniList hydration failed:", e));
  }, []);

  return (
    <div className="app-container">
      {!isReaderView && <Header />}
      <StatusBanner />
      <main className="main-content">
        {isReaderView ? (
          <ReaderPage mangaId={route.mangaId} chapterId={route.chapterId} />
        ) : (
          <MangaDetailPage mangaId="blue-box" />
        )}
      </main>
      {!isReaderView && <Footer />}
      <SettingsModal />
      <ShortcutsModal />
    </div>
  );
}

export default function App() {
  return (
    <RomanceProvider>
      <MainApp />
    </RomanceProvider>
  );
}
