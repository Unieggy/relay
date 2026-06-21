/// <reference types="vite/client" />

interface Window {
  /** Present only inside the Relay desktop (Electron) shell. */
  relay?: {
    pickWorkspace: () => Promise<string | null>;
  };
}
