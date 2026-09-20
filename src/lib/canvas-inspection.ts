const STORAGE_KEY = "flies.canvas.inspect-html";
const listeners = new Set<() => void>();
let inspection: boolean | undefined;
let listeningWindow: Window | undefined;

function readStoredPreference(): boolean | undefined {
  if (typeof window === "undefined") return;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    // Private or restricted storage still permits an in-memory preference.
    return;
  }
}

function publish(enabled: boolean) {
  const previous = inspection;
  inspection = enabled;
  if (enabled !== previous) listeners.forEach((listener) => listener());
}

function handleStorage(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  try {
    if (event.storageArea !== listeningWindow?.localStorage) return;
  } catch {
    return;
  }
  publish(event.key === STORAGE_KEY && event.newValue === "true");
}

export function getCanvasInspection(): boolean {
  inspection ??= readStoredPreference() ?? false;
  return inspection;
}

export function setCanvasInspection(enabled: boolean): void {
  // Initialize before publishing so setting the current value does not notify twice.
  getCanvasInspection();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {
      // Keep the user's choice for this session even when persistence is unavailable.
    }
  }
  publish(enabled);
}

export function subscribeCanvasInspection(listener: () => void): () => void {
  listeners.add(listener);
  if (!listeningWindow && typeof window !== "undefined") {
    listeningWindow = window;
    listeningWindow.addEventListener("storage", handleStorage);
    // Storage may have changed while no editor was mounted (or after SSR).
    publish(readStoredPreference() ?? getCanvasInspection());
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && listeningWindow) {
      listeningWindow.removeEventListener("storage", handleStorage);
      listeningWindow = undefined;
    }
  };
}
