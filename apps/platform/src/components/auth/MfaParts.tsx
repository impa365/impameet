'use client';

import { type FormEvent, useState } from 'react';
import { useT } from '@/i18n/client';
import { Icon } from '../ui/Icon';

/** The one-time codes, shown once: copy, download, then the user says they kept them. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'codigos-de-recuperacao.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mfa-recovery">
      <h3>
        <Icon name="key" size={20} /> {t('security.setup.recoveryTitle')}
      </h3>
      <p className="muted">{t('security.setup.recoveryIntro')}</p>
      <ol className="mfa-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="row">
        <button
          type="button"
          className="btn secondary small"
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          <Icon name={copied ? 'check' : 'content_copy'} size={16} />
          {copied ? t('security.setup.copied') : t('security.setup.copy')}
        </button>
        <button type="button" className="btn secondary small" onClick={download}>
          <Icon name="download" size={16} />
          {t('security.setup.download')}
        </button>
      </div>
      <button type="button" className="btn" onClick={onDone}>
        {t('security.setup.saved')}
      </button>
    </div>
  );
}

/** A 6-digit (or recovery) code field that suits phones and password managers. */
export function CodeInput({
  label,
  value,
  onChange,
  recovery,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  recovery?: boolean;
}) {
  return (
    <label>
      {label}
      <input
        className="mfa-code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={recovery ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={recovery ? 20 : 8}
        placeholder={recovery ? 'XXXXX-XXXXX' : '000000'}
        autoFocus
      />
    </label>
  );
}

/** Setting up an authenticator app: the QR code, the key in text, then a code to confirm. */
export function TotpSetup({
  setup,
  busy,
  onConfirm,
  onCancel,
}: {
  setup: { secret: string; qr: string };
  busy: boolean;
  onConfirm: (code: string) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => (e.preventDefault(), onConfirm(code));
  return (
    <form className="form mfa-totp" onSubmit={submit} noValidate>
      <p>{t('security.setup.totpScan')}</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- a QR code made on the spot, not a file */}
      <img
        className="mfa-qr"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr)}`}
        alt=""
        width={200}
        height={200}
      />
      <p className="muted small-print">{t('security.setup.totpManual')}</p>
      <code className="mfa-secret">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
      <CodeInput label={t('security.setup.totpCode')} value={code} onChange={setCode} />
      <div className="row">
        <button className="btn" disabled={busy || code.replace(/\D/g, '').length < 6}>
          {busy ? t('security.login.confirming') : t('security.login.confirm')}
        </button>
        {onCancel && (
          <button type="button" className="btn secondary" onClick={onCancel}>
            {t('security.setup.cancel')}
          </button>
        )}
      </div>
    </form>
  );
}
