'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { serverMessage, useLocale, useT } from '@/i18n/client';
import type { MessageKey } from '@/i18n/keys';
import { Icon, type IconName } from '../ui/Icon';
import { api } from '../api';
import { messageOf, useLoad } from './useLoad';

type Kind = 's3' | 'gdrive';
type Mode = 'local' | Kind;

interface StorageView {
  encryption: boolean;
  googleAvailable: boolean;
  recording: boolean;
  storage: {
    kind: Kind;
    endpoint: string | null;
    region: string | null;
    bucket: string | null;
    prefix: string;
    pathStyle: boolean;
    accessKey: string | null;
    googleEmail: string | null;
    folderName: string | null;
    secretHint: string;
    keepLocal: boolean;
    lastTestAt: string | null;
    lastTestOk: boolean | null;
    lastTestError: string | null;
  } | null;
}

const MODES: [Mode, MessageKey, MessageKey, IconName][] = [
  ['local', 'storage.modeLocal', 'storage.modeLocalHint', 'video_library'],
  ['s3', 'storage.modeS3', 'storage.modeS3Hint', 'cloud_upload'],
  ['gdrive', 'storage.modeDrive', 'storage.modeDriveHint', 'upload_file'],
];

/** S3-compatible services: picking one fills the address pattern, never the credentials. */
const PROVIDERS = [
  { id: 'aws', label: 'storage.providerAws', endpoint: '', region: 'us-east-1', pathStyle: false },
  {
    id: 'r2',
    label: 'storage.providerR2',
    endpoint: 'https://<conta>.r2.cloudflarestorage.com',
    region: 'auto',
    pathStyle: false,
  },
  {
    id: 'wasabi',
    label: 'storage.providerWasabi',
    endpoint: 'https://s3.us-east-1.wasabisys.com',
    region: 'us-east-1',
    pathStyle: false,
  },
  {
    id: 'b2',
    label: 'storage.providerB2',
    endpoint: 'https://s3.us-east-005.backblazeb2.com',
    region: 'us-east-005',
    pathStyle: false,
  },
  { id: 'other', label: 'storage.providerOther', endpoint: 'https://', region: '', pathStyle: true },
] as const satisfies readonly {
  id: string;
  label: MessageKey;
  endpoint: string;
  region: string;
  pathStyle: boolean;
}[];

interface Draft {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKey: string;
  secretKey: string;
  folderName: string;
  keepLocal: boolean | null;
}

const draftOf = (s: StorageView['storage']): Draft => ({
  endpoint: s?.endpoint ?? '',
  region: s?.region ?? '',
  bucket: s?.bucket ?? '',
  prefix: s?.prefix ?? '',
  pathStyle: s?.pathStyle ?? false,
  accessKey: s?.accessKey ?? '',
  secretKey: '',
  folderName: s?.folderName ?? 'IMPA Meet - Gravações',
  keepLocal: s ? s.keepLocal : null,
});

const STATUS: Record<string, MessageKey> = {
  connected: 'storage.statusConnected',
  cancelled: 'storage.statusCancelled',
  error: 'storage.statusError',
  scope: 'storage.statusScope',
};

/** Where the organization's recordings go: the server, S3 (or compatible) or Google Drive. */
export function StorageTab() {
  const t = useT();
  const locale = useLocale();
  const { data, error, setError, reload } = useLoad<StorageView>('/api/admin/storage');
  const current = data?.storage ?? null;
  const [mode, setMode] = useState<Mode>('local');
  const [draft, setDraft] = useState<Draft>(draftOf(null));
  const [busy, setBusy] = useState<'save' | 'test' | 'connect' | 'remove' | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft({ ...draft, [k]: v });

  useEffect(() => {
    if (!data) return;
    setMode(data.storage?.kind ?? 'local');
    setDraft(draftOf(data.storage));
  }, [data]);

  // Back from Google: say how it went, and clean the address.
  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get('storage');
    if (!status) return;
    setNotice({ ok: status === 'connected', text: t(STATUS[status] ?? 'storage.statusError') });
    url.searchParams.delete('storage');
    window.history.replaceState(null, '', url.toString());
  }, [t]);

  const when = (iso: string) => new Date(iso).toLocaleString(locale);

  async function run(kind: NonNullable<typeof busy>, work: () => Promise<void>) {
    setBusy(kind);
    setError('');
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err, t('storage.couldNotSave')));
    } finally {
      setBusy(null);
    }
  }

  const saveS3 = (e: FormEvent) => {
    e.preventDefault();
    void run('save', async () => {
      await api('/api/admin/storage', {
        method: 'PUT',
        body: {
          endpoint: draft.endpoint.trim() || null,
          region: draft.region.trim(),
          bucket: draft.bucket.trim(),
          prefix: draft.prefix.trim(),
          pathStyle: draft.pathStyle,
          accessKey: draft.accessKey.trim(),
          secretKey: draft.secretKey || undefined,
          keepLocal: draft.keepLocal,
        },
      });
      await reload();
      setNotice({ ok: true, text: `${t('storage.saved')} ${t('storage.onlyNew')}` });
    });
  };

  const connectDrive = () =>
    run('connect', async () => {
      const { url } = await api<{ url: string }>('/api/admin/storage/google', {
        body: { folderName: draft.folderName.trim(), keepLocal: draft.keepLocal },
      });
      window.location.assign(url);
    });

  const test = () =>
    run('test', async () => {
      const res = await api<{ ok: boolean; error: string | null }>('/api/admin/storage/test', { body: {} });
      setNotice(
        res.ok
          ? { ok: true, text: t('storage.testOk') }
          : { ok: false, text: t('storage.testFailed', { error: serverMessage(res.error ?? '') }) },
      );
      await reload();
    });

  const keepLocal = (value: boolean) =>
    current?.kind === mode
      ? run('save', async () => {
          await api('/api/admin/storage', { method: 'PATCH', body: { keepLocal: value } });
          await reload();
        })
      : set('keepLocal', value);

  const removeIt = () => {
    const extra = current?.kind === 'gdrive' ? t('storage.removeDriveExtra') : '';
    if (!window.confirm(t('storage.removeConfirm', { extra }))) return;
    void run('remove', async () => {
      await api('/api/admin/storage', { method: 'DELETE', body: {} });
      await reload();
      setNotice({ ok: true, text: t('storage.removed') });
    });
  };

  const keepChoice = (
    <fieldset className="plain">
      <legend>{t('storage.keepLocal')}</legend>
      {([true, false] as const).map((value) => (
        <label key={String(value)} className="radio-row">
          <input
            type="radio"
            name="keep-local"
            checked={(current?.kind === mode ? current.keepLocal : draft.keepLocal) === value}
            onChange={() => void keepLocal(value)}
          />
          <span>{value ? t('storage.keepLocalYes') : t('storage.keepLocalNo')}</span>
        </label>
      ))}
      <span className="field-help">{t('storage.keepLocalHelp')}</span>
    </fieldset>
  );

  const lastTest =
    current?.kind === mode && current.lastTestAt ? (
      <span className={current.lastTestOk ? 'muted' : 'error'}>
        {current.lastTestOk
          ? t('storage.lastOk', { when: when(current.lastTestAt) })
          : t('storage.lastFailed', {
              when: when(current.lastTestAt),
              error: serverMessage(current.lastTestError ?? ''),
            })}
      </span>
    ) : null;

  return (
    <div className="settings-form storage-tab">
      <div className="page-head">
        <p>{t('storage.intro')}</p>
      </div>
      {data && !data.encryption && <p className="int-empty">{t('storage.encryptionMissing')}</p>}
      {data && !data.recording && <p className="int-empty">{t('storage.noRecording')}</p>}
      <section className="settings-section">
        <header className="section-head">
          <h3>{t('storage.how')}</h3>
        </header>
        <div className="kind-chooser" role="radiogroup" aria-label={t('storage.how')}>
          {MODES.map(([id, label, hint, icon]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={mode === id ? 'kind-option selected' : 'kind-option'}
              onClick={() => (setMode(id), setNotice(null))}
            >
              <span className="int-icon tile-avatar" aria-hidden>
                <Icon name={icon} size={20} />
              </span>
              <span>
                <strong>{t(label)}</strong>
                <small>
                  {id === 'gdrive' && data && !data.googleAvailable ? t('storage.driveUnavailable') : t(hint)}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>

      {mode === 'local' && current && (
        <div className="save-bar">
          <button type="button" className="btn secondary" disabled={busy !== null} onClick={removeIt}>
            {t('storage.remove')}
          </button>
        </div>
      )}

      {mode === 's3' && (
        <form className="form settings-section" onSubmit={saveS3} noValidate>
          <div className="preset-grid" role="group" aria-label={t('storage.provider')}>
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={draft.endpoint === p.endpoint ? 'preset active' : 'preset'}
                onClick={() =>
                  setDraft({ ...draft, endpoint: p.endpoint, region: p.region, pathStyle: p.pathStyle })
                }
              >
                {t(p.label)}
              </button>
            ))}
          </div>
          <label>
            {t('storage.endpoint')}
            <input
              inputMode="url"
              maxLength={300}
              value={draft.endpoint}
              onChange={(e) => set('endpoint', e.target.value)}
              placeholder="https://…"
            />
            <span className="field-help">{t('storage.endpointHelp')}</span>
          </label>
          <div className="fields">
            <label>
              {t('storage.region')}
              <input
                required
                maxLength={30}
                value={draft.region}
                onChange={(e) => set('region', e.target.value)}
              />
              <span className="field-help">{t('storage.regionHelp')}</span>
            </label>
            <label>
              {t('storage.bucket')}
              <input
                required
                maxLength={63}
                value={draft.bucket}
                onChange={(e) => set('bucket', e.target.value)}
              />
            </label>
          </div>
          <label>
            {t('storage.prefix')}
            <input maxLength={200} value={draft.prefix} onChange={(e) => set('prefix', e.target.value)} />
            <span className="field-help">{t('storage.prefixHelp')}</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={draft.pathStyle}
              onChange={(e) => set('pathStyle', e.target.checked)}
            />
            <span>
              {t('storage.pathStyle')}
              <small>{t('storage.pathStyleHelp')}</small>
            </span>
          </label>
          <div className="fields">
            <label>
              {t('storage.accessKey')}
              <input
                required
                autoComplete="off"
                maxLength={200}
                value={draft.accessKey}
                onChange={(e) => set('accessKey', e.target.value)}
              />
            </label>
            <label>
              {t('storage.secretKey')}
              <input
                type="password"
                autoComplete="new-password"
                maxLength={200}
                value={draft.secretKey}
                placeholder={
                  current?.kind === 's3' ? `${t('storage.keepSecret')} (…${current.secretHint})` : ''
                }
                onChange={(e) => set('secretKey', e.target.value)}
              />
            </label>
          </div>
          <span className="field-help">{t('storage.s3Help')}</span>
          {keepChoice}
          <div className="save-bar">
            <button className="btn" disabled={busy !== null || !data?.encryption || draft.keepLocal === null}>
              {busy === 'save' ? t('storage.saving') : t('storage.save')}
            </button>
            {current?.kind === 's3' && (
              <button
                type="button"
                className="btn secondary"
                disabled={busy !== null}
                onClick={() => void test()}
              >
                {busy === 'test' ? t('storage.testing') : t('storage.test')}
              </button>
            )}
            {lastTest}
          </div>
        </form>
      )}

      {mode === 'gdrive' && (
        <section className="settings-section">
          {current?.kind === 'gdrive' && (
            <p className="status-line">
              <span className={current.lastTestOk === false ? 'status-dot bad' : 'status-dot'} aria-hidden />
              {t('storage.connectedAs', { email: current.googleEmail ?? '—' })} ·{' '}
              {t('storage.connectedFolder', { folder: current.folderName ?? '—' })}
            </p>
          )}
          <label>
            {t('storage.folderName')}
            <input
              maxLength={120}
              value={draft.folderName}
              onChange={(e) => set('folderName', e.target.value)}
            />
          </label>
          {keepChoice}
          <p className="field-help">{t('storage.driveHelp')}</p>
          <div className="save-bar">
            <button
              type="button"
              className="btn"
              disabled={
                busy !== null ||
                !data?.googleAvailable ||
                !data.encryption ||
                (current?.kind !== 'gdrive' && draft.keepLocal === null) ||
                !draft.folderName.trim()
              }
              onClick={() => void connectDrive()}
            >
              <Icon name="upload_file" size={18} />
              {busy === 'connect'
                ? t('storage.connecting')
                : current?.kind === 'gdrive'
                  ? t('storage.reconnect')
                  : t('storage.connect')}
            </button>
            {current?.kind === 'gdrive' && (
              <button
                type="button"
                className="btn secondary"
                disabled={busy !== null}
                onClick={() => void test()}
              >
                {busy === 'test' ? t('storage.testing') : t('storage.test')}
              </button>
            )}
            {lastTest}
          </div>
        </section>
      )}

      {notice && (
        <p className={notice.ok ? 'status-line' : 'error'} role="status">
          {notice.text}
        </p>
      )}
      <div className="error" role="alert">
        {error}
      </div>
    </div>
  );
}
