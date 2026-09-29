import type { PageRegion } from "@/lib/domain/types";

/**
 * Browser asset store for the ORIGINAL visual material of uploaded PDFs:
 * every page rendered as an image, plus cropped figures. IndexedDB, not
 * localStorage: a lecture's pages are megabytes, and localStorage is where
 * the curriculum and learner state live.
 *
 * Assets are addressed by id (`${documentId}#p${page}[#f${n}]`, see
 * `lib/visuals/analyze.ts`) and carry their provenance. Nothing here is
 * generated: an asset is always a region of an uploaded page.
 *
 * Everything is best effort: a missing database (private mode, cleared
 * site data, an old browser) degrades to cards without images, never to an
 * error in the Study loop.
 */

export const ASSET_DB_NAME = "medrecall.assets.v1";
const STORE = "assets";

export interface StoredAsset {
  id: string;
  documentId: string;
  pageNumber: number;
  kind: "page" | "figure";
  region?: PageRegion;
  width: number;
  height: number;
  blob: Blob;
  createdAt: string;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(ASSET_DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("documentId", "documentId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** Store (or replace) assets. Returns false when nothing could be written. */
export async function putAssets(assets: readonly StoredAsset[]): Promise<boolean> {
  if (assets.length === 0) return true;
  const db = await open();
  if (!db) return false;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const asset of assets) store.put(asset);
    return await done(tx);
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  const db = await open();
  if (!db) return null;
  try {
    return await new Promise<StoredAsset | null>((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      request.onsuccess = () => resolve((request.result as StoredAsset | undefined) ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Every stored asset of a document, pages first, in page order. */
export async function listDocumentAssets(documentId: string): Promise<StoredAsset[]> {
  const db = await open();
  if (!db) return [];
  try {
    const rows = await new Promise<StoredAsset[]>((resolve) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).index("documentId").getAll(documentId);
      request.onsuccess = () => resolve((request.result as StoredAsset[]) ?? []);
      request.onerror = () => resolve([]);
    });
    return rows.sort((a, b) => a.pageNumber - b.pageNumber || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function deleteDocumentAssets(documentId: string): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    const index = tx.objectStore(STORE).index("documentId");
    const request = index.openKeyCursor(IDBKeyRange.only(documentId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore(STORE).delete(cursor.primaryKey);
      cursor.continue();
    };
    await done(tx);
  } catch {
    // best effort
  } finally {
    db.close();
  }
}

/** Remove every asset (a Reset). */
export async function clearAssets(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch {
    // best effort
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ */
/* Object URLs                                                         */
/* ------------------------------------------------------------------ */

const urls = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

/** An object URL for an asset, cached for the page's lifetime; null when missing. */
export function loadAssetUrl(id: string): Promise<string | null> {
  const cached = urls.get(id);
  if (cached) return Promise.resolve(cached);
  const inFlight = pending.get(id);
  if (inFlight) return inFlight;
  const promise = getAsset(id)
    .then((asset) => {
      if (!asset || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
      const url = URL.createObjectURL(asset.blob);
      urls.set(id, url);
      return url;
    })
    .catch(() => null)
    .finally(() => pending.delete(id));
  pending.set(id, promise);
  return promise;
}

/** Forget cached URLs (after a Reset or a document's assets were replaced). */
export function forgetAssetUrls(): void {
  for (const url of urls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
  urls.clear();
}
