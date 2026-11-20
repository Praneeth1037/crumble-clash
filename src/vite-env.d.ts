/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Room server origin for static hosting (e.g. https://crumble-clash.onrender.com). Empty: same host as the page. */
  readonly VITE_ROOM_SERVER?: string;
}
