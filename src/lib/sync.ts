/**
 * Sync engine: pulls institution data into local IndexedDB on login,
 * and pushes pending offline writes to Supabase when online.
 *
 * Tombstones: when a record is deleted locally, a tombstone entry is
 * written to the deletion_tombstones store. The tombstone persists until
 * the cloud delete is confirmed, preventing background refreshes from
 * resurrecting the record via localBulkPut. Once the delete succeeds
 * (immediately or via syncPending), the tombstone is removed.
 *
 * Conflict resolution: uses updated_at timestamps. When a background
 * refresh pulls a record from the server, it only overwrites the local
 * copy if the server's updated_at is newer than or equal to the local
 * copy's updated_at AND there is no pending sync operation for that
 * record. This prevents overwriting locally-edited data that hasn't
 * synced yet.
 */
import { supabase } from './supabase';
import {
  localGetAll, localBulkPut, localClearAll, localDelete, localGetByKey,
  getPendingSync, removeSyncOp, enqueueSync, pendingSyncCount,
  addTombstone, removeTombstone, getTombstone, getAllTombstones,
  updateSyncOp, getSyncMeta, setSyncMeta,
  type StoreName, type SyncOp,
} from './offline-db';
import type {
  ClassRow, Student, Lesson, AttendanceRecord, TeacherAbsence,
  AbsenceEpisode, Teacher, InstitutionSettings, ClassAssignment,
  Profile, Institution, DeveloperInfo,
} from './types';

type SyncStatus = 'idle' | 'syncing' | 'online' | 'offline' | 'error';
type SyncListener = (status: SyncStatus, pending: number) => void;

let currentStatus: SyncStatus = navigator.onLine ? 'online' : 'offline';
let listeners: SyncListener[] = [];

export function onSyncStatusChange(fn: SyncListener): () => void {
  listeners.push(fn);
  fn(currentStatus, 0);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

function setStatus(s: SyncStatus, pending: number) {
  currentStatus = s;
  for (const l of listeners) l(s, pending);
}

window.addEventListener('online', () => {
  setStatus('online', 0);
  syncPending();
});
window.addEventListener('offline', () => setStatus('offline', 0));

// Sync when the app resumes / visibility returns (Capacitor + browser)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && navigator.onLine) {
    syncPending();
  }
});

const MAX_RETRY_ATTEMPTS = 50;

// =========== Full data preload on login ===========

export async function preloadInstitutionData(institutionId: string): Promise<void> {
  setStatus('syncing', 0);

  const queries: { store: StoreName; fn: () => Promise<{ data: unknown[] | null }> }[] = [
    { store: 'institutions', fn: async () => { const r = await supabase.from('institutions').select('*').eq('id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'classes', fn: async () => { const r = await supabase.from('classes').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'students', fn: async () => { const r = await supabase.from('students').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'lessons', fn: async () => { const r = await supabase.from('lessons').select('*, classes!inner(institution_id)').eq('classes.institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'attendance_records', fn: async () => { const r = await supabase.from('attendance_records').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'teacher_absences', fn: async () => { const r = await supabase.from('teacher_absences').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'absence_episodes', fn: async () => { const r = await supabase.from('absence_episodes').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'teachers', fn: async () => { const r = await supabase.from('teachers').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'teacher_class_assignments', fn: async () => { const r = await supabase.from('teacher_class_assignments').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'teacher_lesson_assignments', fn: async () => { const r = await supabase.from('teacher_lesson_assignments').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'institution_settings', fn: async () => { const r = await supabase.from('institution_settings').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'class_assignments', fn: async () => { const r = await supabase.from('class_assignments').select('*, profiles!inner(institution_id)').eq('profiles.institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'profiles', fn: async () => { const r = await supabase.from('profiles').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
    { store: 'developer_info', fn: async () => { const r = await supabase.from('developer_info').select('*').eq('institution_id', institutionId); return { data: r.data as unknown[] | null }; } },
  ];

  // First load: clear and preload. This only runs on login, not on every refresh.
  await localClearAll();

  const results = await Promise.allSettled(queries.map((q) => q.fn()));
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const { store } = queries[i];
    if (result.status === 'fulfilled' && result.value.data) {
      let rows = result.value.data as Record<string, unknown>[];
      if (store === 'lessons') {
        rows = rows.map((r) => {
          const { classes: _c, ...rest } = r;
          return rest;
        });
      }
      if (store === 'class_assignments') {
        rows = rows.map((r) => {
          const { profiles: _p, ...rest } = r;
          return rest;
        });
      }
      await localBulkPut(store, rows as { id: string }[]);
    }
  }

  await setSyncMeta('last_full_sync', new Date().toISOString());
  const pending = await pendingSyncCount();
  setStatus(navigator.onLine ? 'online' : 'offline', pending);
}

// =========== Incremental refresh (background, non-destructive) ===========

/**
 * Refreshes a single table from Supabase into local IndexedDB.
 * Uses conflict resolution: only overwrites local records that are not
 * pending sync and whose server updated_at is newer or equal.
 * Returns the fresh rows for the caller to use in setState.
 */
export async function refreshTable<T extends { id: string; updated_at?: string }>(
  store: StoreName,
  query: Promise<{ data: T[] | null; error: { code?: string } | null }>,
): Promise<T[]> {
  const result = await query;
  if (result.error || !result.data) return [];

  const fresh = result.data;
  const local = await localGetAll<T>(store);
  const localMap = new Map(local.map((r) => [r.id, r]));

  // Get pending sync op record_ids for this table to avoid overwriting pending writes
  const pending = await getPendingSync();
  const pendingIds = new Set(pending.filter((o) => o.table_name === store).map((o) => o.record_id));

  // Get tombstoned ids to prevent resurrecting deleted records
  const tombstones = await getAllTombstones();
  const tombstonedIds = new Set(tombstones.filter((t) => t.store_name === store).map((t) => t.id));

  const toPut: T[] = [];
  for (const row of fresh) {
    if (tombstonedIds.has(row.id)) continue;
    if (pendingIds.has(row.id)) {
      // Don't overwrite a record that has a pending local write
      continue;
    }
    const localRow = localMap.get(row.id);
    if (localRow) {
      const localUpdated = localRow.updated_at ?? '';
      const serverUpdated = row.updated_at ?? '';
      // Only overwrite if server is newer or equal (equal handles records without updated_at)
      if (serverUpdated < localUpdated) continue;
    }
    toPut.push(row);
  }

  if (toPut.length > 0) await localBulkPut(store, toPut);
  return fresh;
}

// =========== Push pending writes to Supabase ===========

export async function syncPending(): Promise<void> {
  if (!navigator.onLine) return;
  const ops = await getPendingSync();
  if (ops.length === 0) {
    setStatus(navigator.onLine ? 'online' : 'offline', 0);
    return;
  }

  setStatus('syncing', ops.length);

  let hadError = false;

  for (const op of ops) {
    // Skip ops that have exceeded retry limit
    if (op.attempts >= MAX_RETRY_ATTEMPTS) {
      hadError = true;
      continue;
    }

    try {
      const table = supabase.from(op.table_name);
      let result;
      if (op.operation === 'delete') {
        result = await table.delete().eq('id', op.record_id);
      } else if (op.operation === 'insert') {
        result = await table.insert(op.payload);
      } else {
        result = await table.update(op.payload).eq('id', op.record_id);
      }

      if (result.error) {
        const code = result.error.code ?? '';
        // 42501 = RLS denial; retrying won't help — leave in queue but mark error
        if (code === '42501') {
          console.error(`[sync] Authorization error on ${op.operation} ${op.table_name} ${op.record_id}:`, result.error.message);
          await updateSyncOp(op.id, {
            attempts: op.attempts + 1,
            last_error: result.error.message,
            last_attempt_at: new Date().toISOString(),
          });
          hadError = true;
          continue;
        }
        // 23505 = unique constraint violation — for inserts, try update instead
        if (code === '23505' && op.operation === 'insert') {
          result = await table.update(op.payload).eq('id', op.record_id);
          if (!result.error) {
            await removeSyncOp(op.id);
            continue;
          }
        }
        // Other errors (network, timeout, constraint) — leave for retry
        await updateSyncOp(op.id, {
          attempts: op.attempts + 1,
          last_error: result.error.message,
          last_attempt_at: new Date().toISOString(),
        });
        hadError = true;
        continue;
      }

      // Success — remove from queue and clean up tombstone if it was a delete
      await removeSyncOp(op.id);
      if (op.operation === 'delete') {
        await removeTombstone(op.record_id);
      }
    } catch {
      // Network-level failure — leave in queue for retry
      await updateSyncOp(op.id, {
        attempts: op.attempts + 1,
        last_error: 'network_error',
        last_attempt_at: new Date().toISOString(),
      });
      hadError = true;
    }
  }

  await setSyncMeta('last_sync', new Date().toISOString());
  const remaining = await pendingSyncCount();
  setStatus(remaining > 0 ? (hadError ? 'error' : 'online') : (hadError ? 'error' : 'online'), remaining);
}

// =========== Write-through: local + queue ===========

export async function writeThrough<T extends { id: string }>(
  store: StoreName,
  table: string,
  record: T,
  operation: 'insert' | 'update',
): Promise<void> {
  const rec = record as unknown as Record<string, unknown>;
  // If there was a tombstone for this id (e.g. re-creating a previously-deleted record),
  // remove it — the new write supersedes the deletion.
  await removeTombstone(record.id);
  // Write to local immediately
  await localBulkPut(store, [rec as { id: string }]);
  // If online, push directly; otherwise queue
  if (navigator.onLine) {
    try {
      let result;
      if (operation === 'insert') {
        result = await supabase.from(table).insert(rec);
      } else {
        result = await supabase.from(table).update(rec).eq('id', record.id);
      }
      if (result.error) {
        // Cloud write failed — enqueue for retry
        await enqueueSync({ table_name: table, operation, record_id: record.id, payload: rec });
      }
    } catch {
      await enqueueSync({ table_name: table, operation, record_id: record.id, payload: rec });
    }
  } else {
    await enqueueSync({ table_name: table, operation, record_id: record.id, payload: rec });
  }
}

export async function deleteThrough(store: StoreName, table: string, id: string): Promise<void> {
  // Delete from local immediately
  await localDelete(store, id);
  // Write tombstone to prevent resurrection by background refresh
  await addTombstone({
    id,
    store_name: store,
    table_name: table,
    deleted_at: new Date().toISOString(),
  });
  if (navigator.onLine) {
    try {
      const result = await supabase.from(table).delete().eq('id', id);
      if (result.error) {
        // Cloud delete failed — enqueue for retry, keep tombstone
        await enqueueSync({ table_name: table, operation: 'delete', record_id: id, payload: {} });
      } else {
        // Cloud delete confirmed — remove tombstone
        await removeTombstone(id);
      }
    } catch {
      // Network failure — enqueue for retry, keep tombstone
      await enqueueSync({ table_name: table, operation: 'delete', record_id: id, payload: {} });
    }
  } else {
    await enqueueSync({ table_name: table, operation: 'delete', record_id: id, payload: {} });
  }
}

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export async function getLastSyncTime(): Promise<string | null> {
  return getSyncMeta('last_sync');
}

export async function getFailedOps(): Promise<SyncOp[]> {
  const ops = await getPendingSync();
  return ops.filter((o) => o.attempts > 0);
}

export async function retryFailedOps(): Promise<void> {
  // Reset attempt counters for failed ops so they get retried
  const ops = await getPendingSync();
  for (const op of ops) {
    if (op.attempts > 0 && op.attempts < MAX_RETRY_ATTEMPTS) {
      await updateSyncOp(op.id, { attempts: 0, last_error: null, last_attempt_at: null });
    }
  }
  await syncPending();
}

// Re-export for convenience
export { localGetAll, localBulkPut, localDelete, localGetByKey, enqueueSync, pendingSyncCount, getTombstone, removeTombstone, getAllTombstones };
