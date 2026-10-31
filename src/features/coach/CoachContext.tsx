import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";
import type { SpotContext } from "./prompt";

// The sheet pulls in the Anthropic SDK and the markdown renderer; load it on first use.
const CoachSheet = lazy(() => import("./CoachSheet"));

interface CoachApi {
  open: (spot: SpotContext) => void;
}

const CoachCtx = createContext<CoachApi>({ open: () => {} });
export const useCoach = () => useContext(CoachCtx);

export function CoachProvider({ children, onNeedKey }: { children: ReactNode; onNeedKey: () => void }) {
  const [spot, setSpot] = useState<SpotContext | null>(null);
  return (
    <CoachCtx.Provider value={{ open: setSpot }}>
      {children}
      {spot && (
        <Suspense fallback={<div className="sheet-backdrop" />}>
          <CoachSheet
            key={spot.id}
            spot={spot}
            onClose={() => setSpot(null)}
            onNeedKey={() => {
              setSpot(null);
              onNeedKey();
            }}
          />
        </Suspense>
      )}
    </CoachCtx.Provider>
  );
}
