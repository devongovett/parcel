export declare interface PrecacheEntry {
  integrity?: string;
  url: string;
  revision?: string | null;
}

export const manifest: string[];
export const precacheManifest: PrecacheEntry[];
export const version: string;
