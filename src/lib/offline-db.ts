/**
 * Offline-first local storage layer using IndexedDB.
 * Acts as the primary data source for the app; Supabase is the sync target.
 * All reads come from here; all writes go here first, then sync to Supabase.
 *
 * DB_VERSION 3 adds: sync_meta store for tracking last-sync timestamps.
 * Existing data (v1/v2) is preserved during the upgrade.
 */

const DB_NAME = 'edutrack_offline';
const DB_VERSION = 3;

export const STORES = [
  'classes', 'students', 'lessons', 'attendance_records',
  'teacher_absences', 'absence_episodes', 'teachers',
  'teacher_class_assignments', 'teacher_lesson_assignments',
  'institution_settings', 'class_assignments', 'profiles',
  'institutions', 'developer_info', 'pending_sync',
] as const;

export const TOMBSTONE_STORE = 'deletion_tombstones';
export const META_STORE = 'sync_meta';

export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
      if (!db.objectStoreNames.contains('pending_sync')) {
        db.createObjectStore('pending_sync', { keyPath: 'id' });
      }
      if (event.oldVersion < 2 && !db.objectStoreNames.contains(TOMBSTONE_STORE)) {
        db.createObjectStore(TOMBSTONE_STORE, { keyPath: 'id' });
      }
      if (event.oldVersion < 3 && !db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function localGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

export async function localGetByKey<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function localBulkPut<T extends { id: string }>(store: StoreName, items: T[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    for (const item of items) os.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function localPut<T extends { id: string }>(store: StoreName, item: T): Promise<void> {
  return localBulkPut(store, [item]);
}

export async function localDelete(store: StoreName, id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function localClear(store: StoreName): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function localClearAll(): Promise<void> {
  for (const store of STORES) {
    await localClear(store);
  }
}

export async function localCount(store: StoreName): Promise<number> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// =========== Sync metadata ===========

export async function getSyncMeta(key: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => resolve((req.result as { key: string; value: string } | undefined)?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setSyncMeta(key: string, value: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// =========== Sync queue ===========

export interface SyncOp {
  id: string;
  table_name: string;
  operation: 'insert' | 'update' | 'delete';
  record_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  last_error: string | null;
  last_attempt_at: string | null;
}

export async function enqueueSync(op: Omit<SyncOp, 'id' | 'created_at' | 'attempts' | 'last_error' | 'last_attempt_at'>): Promise<void> {
  const full: SyncOp = {
    ...op,
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    last_attempt_at: null,
  };
  await localPut('pending_sync', full);
}

export async function getPendingSync(): Promise<SyncOp[]> {
  return localGetAll<SyncOp>('pending_sync');
}

export async function updateSyncOp(id: string, updates: Partial<Pick<SyncOp, 'attempts' | 'last_error' | 'last_attempt_at'>>): Promise<void> {
  const ops = await getPendingSync();
  const op = ops.find((o) => o.id === id);
  if (!op) return;
  await localPut('pending_sync', { ...op, ...updates });
}

export async function removeSyncOp(id: string): Promise<void> {
  await localDelete('pending_sync', id);
}

export async function pendingSyncCount(): Promise<number> {
  return localCount('pending_sync');
}

// =========== Deletion tombstones ===========

export interface Tombstone {
  id: string;
  store_name: string;
  table_name: string;
  deleted_at: string;
}

export async function addTombstone(t: Tombstone): Promise<void> {
  await localPut(TOMBSTONE_STORE as StoreName, t);
}

export async function removeTombstone(id: string): Promise<void> {
  await localDelete(TOMBSTONE_STORE as StoreName, id);
}

export async function getTombstone(id: string): Promise<Tombstone | undefined> {
  return localGetByKey<Tombstone>(TOMBSTONE_STORE as StoreName, id);
}

export async function getAllTombstones(): Promise<Tombstone[]> {
  return localGetAll<Tombstone>(TOMBSTONE_STORE as StoreName);
}

export async function clearTombstonesForStore(store: StoreName): Promise<void> {
  const all = await getAllTombstones();
  const toRemove = all.filter((t) => t.store_name === store);
  for (const t of toRemove) await removeTombstone(t.id);
}
