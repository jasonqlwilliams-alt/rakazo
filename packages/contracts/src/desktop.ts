export interface DesktopPickedFile {
  name: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface RakazoDesktop {
  platform: string;
  /** Optional during rolling desktop upgrades; the web-safe input is the fallback. */
  file?: {
    pick: (input: { botId: string }) => Promise<DesktopPickedFile[]>;
  };
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
}
