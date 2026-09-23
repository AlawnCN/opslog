import { PasswordInput } from "./PasswordInput";

interface EnvironmentCredentialImportDialogProps {
  passphrase: string;
  busy: boolean;
  error?: string;
  onPassphraseChange: (value: string) => void;
  onImport: () => void;
  onCancel: () => void;
}

export const EnvironmentCredentialImportDialog = ({ passphrase, busy, error, onPassphraseChange, onImport, onCancel }: EnvironmentCredentialImportDialogProps) =>
  <div className="environment-credential-backdrop" role="presentation" onMouseDown={(event) => { event.stopPropagation(); if (!busy) onCancel(); }}>
    <section className="environment-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="environment-credential-import-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span className="eyebrow">ENCRYPTED CONFIGURATION</span><h3 id="environment-credential-import-title">解密环境配置</h3><p>配置文件包含加密的 ELK / SSH 密码。输入导出时设置的密钥后，才能选择导入范围。</p></header>
      <div className="environment-credential-fields"><div className="environment-secret-field"><label htmlFor="environment-import-key">解密密钥</label><PasswordInput id="environment-import-key" secretLabel="解密密钥" autoFocus autoComplete="off" value={passphrase} disabled={busy} onChange={(event) => onPassphraseChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (!busy && passphrase) onImport(); } }} /></div>{error && <p role="alert">{error}</p>}</div>
      <footer><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="button" className="primary" disabled={busy || !passphrase} onClick={onImport}>{busy ? "解密中…" : "解密并预览"}</button></footer>
    </section>
  </div>;
