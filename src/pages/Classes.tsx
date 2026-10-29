import { useEffect, useState, useCallback } from 'react';
import { BookOpen, Plus, Pencil, Archive, ArchiveRestore, Search, Trash2, Upload, Download, AlertCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { localGetAll, localBulkPut } from '@/lib/offline-db';
import { writeThrough, deleteThrough } from '@/lib/sync';
import { Modal, EmptyState, Spinner, Badge, ConfirmDialog } from '@/components/ui';
import ExcelImportModal from '@/components/ExcelImportModal';
import type { ClassRow } from '@/lib/types';

export default function Classes() {
  const { t } = useI18n();
  const { profile } = useAuth();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState<{ open: boolean; edit?: ClassRow }>({ open: false });
  const [name, setName] = useState('');
  const [confirmDel, setConfirmDel] = useState<ClassRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<'idle' | 'error' | 'not_configured' | 'fetching'>('idle');
  const [downloadMsg, setDownloadMsg] = useState('');

  const isAdmin = profile?.role === 'admin';
  const instId = profile?.institution_id;

  const load = useCallback(async () => {
    if (!instId) return;
    // Read from local IndexedDB first (instant, works offline)
    const local = await localGetAll<ClassRow>('classes');
    const filtered = local
      .filter((c) => c.institution_id === instId)
      .sort((a, b) => a.name.localeCompare(b.name));
    setClasses(filtered);
    setLoading(false);

    // Background refresh from Supabase when online
    try {
      const { data } = await supabase.from('classes').select('*').eq('institution_id', instId).order('name');
      const fresh = (data ?? []) as ClassRow[];
      if (fresh.length > 0 || local.length > 0) {
        await localBulkPut('classes', fresh);
        setClasses(fresh);
      }
    } catch { /* offline — local data is already loaded */ }
  }, [instId]);

  useEffect(() => { load(); }, [load]);

  const filtered = classes.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));

  const openAdd = () => { setName(''); setModal({ open: true }); };
  const openEdit = (c: ClassRow) => { setName(c.name); setModal({ open: true, edit: c }); };

  const save = async () => {
    if (!instId || !name.trim()) return;
    const now = new Date().toISOString();
    if (modal.edit) {
      const updated: ClassRow = {
        ...modal.edit,
        name: name.trim(),
        updated_at: now,
      };
      await writeThrough('classes', 'classes', updated, 'update');
    } else {
      const newClass: ClassRow = {
        id: crypto.randomUUID(),
        institution_id: instId,
        name: name.trim(),
        archived: false,
        created_at: now,
        updated_at: now,
      };
      await writeThrough('classes', 'classes', newClass, 'insert');
    }
    setModal({ open: false });
    load();
  };

  const toggleArchive = async (c: ClassRow) => {
    const updated: ClassRow = { ...c, archived: !c.archived, updated_at: new Date().toISOString() };
    await writeThrough('classes', 'classes', updated, 'update');
    load();
  };

  const del = async (c: ClassRow) => {
    await deleteThrough('classes', 'classes', c.id);
    setConfirmDel(null);
    load();
  };

  const downloadTemplate = async () => {
    if (!instId) return;
    setDownloadStatus('fetching');
    setDownloadMsg('');
    // Try local first, then supabase
    const localSettings = await localGetAll<{ institution_id: string; excel_template_url: string | null }>('institution_settings');
    const localSetting = localSettings.find((s) => s.institution_id === instId);
    let url = localSetting?.excel_template_url?.trim() ?? null;

    if (!url) {
      try {
        const { data } = await supabase
          .from('institution_settings')
          .select('excel_template_url')
          .eq('institution_id', instId)
          .maybeSingle();
        url = (data as { excel_template_url: string | null } | null)?.excel_template_url?.trim() ?? null;
      } catch { /* offline */ }
    }

    if (!url) {
      setDownloadStatus('not_configured');
      setDownloadMsg(t('url_empty'));
      return;
    }
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') {
        setDownloadStatus('error');
        setDownloadMsg(t('url_invalid'));
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      setDownloadStatus('idle');
    } catch {
      setDownloadStatus('error');
      setDownloadMsg(t('url_invalid'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={16} className="absolute inset-y-0 start-0 my-auto ms-3 text-muted" />
          <input className="input ps-9" placeholder={t('search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {isAdmin && <button onClick={openAdd} className="btn btn-primary"><Plus size={18} />{t('add_class')}</button>}
      </div>

      {/* Excel import / template section */}
      {isAdmin && (
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="card space-y-3">
            <div className="flex items-center gap-2">
              <Upload size={20} style={{ color: 'var(--primary-600)' }} />
              <h3 className="font-semibold">{t('import_class_list')}</h3>
            </div>
            <p className="text-sm text-muted">{t('import_excel_hint')}</p>
            <button onClick={() => setImportOpen(true)} className="btn btn-primary w-full">
              <Upload size={16} />{t('import_class_list')}
            </button>
          </div>
          <div className="card space-y-3">
            <div className="flex items-center gap-2">
              <Download size={20} style={{ color: 'var(--accent)' }} />
              <h3 className="font-semibold">{t('download_template_title')}</h3>
            </div>
            <p className="text-sm text-muted">{t('download_template_hint')}</p>
            <button onClick={downloadTemplate} disabled={downloadStatus === 'fetching'} className="btn btn-ghost w-full" style={{ border: '1px solid var(--border)' }}>
              {downloadStatus === 'fetching'
                ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                : <Download size={16} />}{t('download_template')}
            </button>
            {downloadStatus === 'error' && (
              <div className="space-y-2">
                <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: 'color-mix(in srgb, var(--error) 12%, transparent)', color: 'var(--error)' }}>
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{downloadMsg}</span>
                </div>
              </div>
            )}
            {downloadStatus === 'not_configured' && (
              <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)' }}>
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{downloadMsg}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? <Spinner label={t('loading')} /> : filtered.length === 0 ? (
        <div className="card"><EmptyState icon={<BookOpen size={40} />} text={t('empty')} /></div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((c) => (
            <div key={c.id} className="card flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate">{c.name}</div>
                <div className="mt-1"><Badge color={c.archived ? 'neutral' : 'success'}>{c.archived ? t('archived') : t('classes')}</Badge></div>
              </div>
              {isAdmin && (
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => openEdit(c)} className="btn btn-ghost p-2"><Pencil size={16} /></button>
                  <button onClick={() => toggleArchive(c)} className="btn btn-ghost p-2" title={c.archived ? t('unarchive') : t('archive')}>
                    {c.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                  </button>
                  <button onClick={() => setConfirmDel(c)} className="btn btn-ghost p-2 text-[var(--error)]"><Trash2 size={16} /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={modal.open} onClose={() => setModal({ open: false })} title={modal.edit ? t('edit_class') : t('add_class')}>
        <div className="space-y-4">
          <div>
            <label className="label">{t('class_name')}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setModal({ open: false })} className="btn btn-ghost">{t('cancel')}</button>
            <button onClick={save} className="btn btn-primary">{t('save')}</button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDel}
        onClose={() => setConfirmDel(null)}
        onConfirm={() => confirmDel && del(confirmDel)}
        title={t('delete')}
        message={confirmDel?.name ?? ''}
        confirmLabel={t('delete')}
        danger
      />

      <ExcelImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={load} />
    </div>
  );
}
