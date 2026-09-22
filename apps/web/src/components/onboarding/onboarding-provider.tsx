import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";

import { readTour, tourReducer, type TourAction, type TourState } from "@/lib/onboarding";

const TourContext = createContext<{ state: TourState; dispatch: Dispatch<TourAction> } | null>(
  null,
);

export function OnboardingProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const key = `flies:onboarding:v1:${userId}`;
  const [state, dispatch] = useReducer(tourReducer, key, readTour);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* Keep in-memory progress. */
    }
  }, [key, state]);
  const value = useMemo(() => ({ state, dispatch }), [state]);

  return <TourContext value={value}>{children}</TourContext>;
}

export function useOnboarding() {
  return useContext(TourContext);
}
