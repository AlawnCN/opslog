import { useCallback, useEffect, useRef, useState, useTransition, type ChangeEvent } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { version as buildVersion } from "../../package.json";
import { associateTrcFiles, desktopMode, errorMessage, getTrcAssociationStatus, loadStartupTrcFile, type TrcAssociationStatus, type TrcDocument } from "./api";
import { isQueryFocusShortcut } from "./keyboard-shortcuts";
import { ImportIcon } from "./components/Icons";
import { LogReaderWorkspace, type TransactionLogDrawerHandle } from "./components/TransactionLogDrawer";
import { TrcAssociationGuide } from "./components/TrcAssociationGuide";
import { UpdateDialog } from "./components/UpdateDialog";
import { useAppUpdater } from "./use-app-updater";
import { ReaderTitlebar } from "./components/ReaderTitlebar";

const MAX_TRC_BYTES = 64 * 1024 * 1024;
const ASSOCIATION_PROMPT_KEY = "opslog.reader.trc-association-prompt.v1";

const ReaderFamilyMark = () => <svg className="reader-family-mark" viewBox="0 0 1024 1024" aria-hidden="true">
  <rect x="32" y="32" width="960" height="960" rx="220" />
  <rect x="72" y="72" width="880" height="880" rx="180" />
  <path d="M305 220h294l120 120v464H305z" />
  <path d="M599 220v120h120M375 555h86l39-118 84 236 45-118h90" />
  <circle cx="512" cy="512" r="394" />
</svg>;

export default function ReaderApp() {
  const [currentVersion, setCurrentVersion] = useState(buildVersion);
  const [document, setDocument] = useState<TrcDocument>();
  const [opening, setOpening] = useState(desktopMode);
  const [parsing, startParsing] = useTransition();
  const openRequest = useRef(0);
  const [notice, setNotice] = useState<string>();
  const [associationStatus, setAssociationStatus] = useState<TrcAssociationStatus>();
  const [showAssociationGuide, setShowAssociationGuide] = useState(false);
  const [associating, setAssociating] = useState(false);
  const readerRef = useRef<TransactionLogDrawerHandle>(null);
  const notifyCurrentVersion = useCallback(() => setNotice("当前已是最新版本。"), []);
  const notifyUpdateError = useCallback((message: string) => setNotice(`检查更新失败：${message}`), []);
  const appUpdater = useAppUpdater({ enabled: desktopMode, onCurrent: notifyCurrentVersion, onError: notifyUpdateError });
  useEffect(() => {
    if (!desktopMode) return;
    let disposed = false;
    void getVersion().then((version) => { if (!disposed) setCurrentVersion(version); }).catch(() => { /* Keep the bundled version if the native API is unavailable. */ });
    return () => { disposed = true; };
  }, []);

  const openPendingFile = useCallback(async () => {
    const request = ++openRequest.current;
    setOpening(true);
    try {
      setNotice(undefined);
      const pendingDocument = await loadStartupTrcFile();
      if (request === openRequest.current && pendingDocument) startParsing(()=>setDocument(pendingDocument));
    } catch (error) {
      if (request === openRequest.current) setNotice(errorMessage(error));
    } finally { if (request === openRequest.current) setOpening(false); }
  }, []);

  useEffect(() => {
    if (!desktopMode) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void (async () => {
      unlisten = await listen<string>("reader://open-file", () => {
        if (!disposed) void openPendingFile();
      });
      if (!disposed) await openPendingFile();
    })().catch((error) => {
      if (!disposed) { setNotice(errorMessage(error)); setOpening(false); }
    });
    return () => {
      disposed = true;
      openRequest.current++;
      unlisten?.();
    };
  }, [openPendingFile]);

  useEffect(() => {
    if (!desktopMode) return;
    void getTrcAssociationStatus().then((status) => {
      setAssociationStatus(status);
      const choice = window.localStorage.getItem(ASSOCIATION_PROMPT_KEY);
      setShowAssociationGuide(status.supported && !status.associated && choice !== "dismissed");
    }).catch((error) => setNotice(errorMessage(error)));
  }, []);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape") {
        if (appUpdater.state.visible) {
          event.preventDefault();
          appUpdater.dismissUpdater();
          return;
        }
        if (!document) return;
        event.preventDefault();
        readerRef.current?.closeTopLayer();
      } else if (document && isQueryFocusShortcut(event)) {
        event.preventDefault();
        readerRef.current?.focusSearch();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [appUpdater, document]);

  const openBrowserFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith(".trc")) {
      setNotice("只支持打开 .trc 日志文件");
      return;
    }
    if (file.size > MAX_TRC_BYTES) {
      setNotice("日志文件超过 64 MB 安全上限");
      return;
    }
    const request = ++openRequest.current;
    try {
      setOpening(true);
      setNotice(undefined);
      // Paint the existing reader loading view before parsing the selected file.
      await new Promise<void>((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const content = await file.text();
      if (request === openRequest.current) startParsing(()=>setDocument({ name: file.name, path: file.name, content }));
    } catch (error) {
      if (request === openRequest.current) setNotice(errorMessage(error));
    } finally { if (request === openRequest.current) setOpening(false); }
  };

  const openControl = <label className="reader-open-file">
    <ImportIcon />
    <span>打开 TRC</span>
    <input type="file" accept=".trc" onChange={(event) => void openBrowserFile(event)} />
  </label>;

  const associateFiles = async () => {
    setAssociating(true);
    try {
      setNotice(undefined);
      const status = await associateTrcFiles();
      setAssociationStatus(status);
      if (!status.associated) throw new Error("系统未确认 .trc 文件关联，请稍后重试");
      window.localStorage.setItem(ASSOCIATION_PROMPT_KEY, "associated");
      setShowAssociationGuide(false);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setAssociating(false);
    }
  };

  const dismissAssociationGuide = () => {
    window.localStorage.setItem(ASSOCIATION_PROMPT_KEY, "dismissed");
    setShowAssociationGuide(false);
  };

  const associationSummary = associationStatus?.supported && <section className={`trc-association-summary${associationStatus.associated ? " is-associated" : ""}`}>
    <div><span>文件关联</span><strong>{associationStatus.associated ? ".trc 已关联" : ".trc 尚未关联"}</strong></div>
    {!associationStatus.associated && <button type="button" onClick={() => setShowAssociationGuide(true)}>设置关联</button>}
  </section>;

  const updateBusy = ["checking", "downloading", "installing"].includes(appUpdater.state.phase);
  const updateControl = desktopMode && <button type="button" className="reader-update-control" disabled={updateBusy} title={updateBusy ? "正在处理更新" : "点击版本号检查更新"} aria-label={`当前版本 ${currentVersion}，点击检查更新`} aria-busy={updateBusy} onClick={() => void appUpdater.checkForUpdates()}>{updateBusy && <span className="button-spinner" aria-hidden="true" />}v{currentVersion}</button>;
  const updateDialog = <UpdateDialog appName="OpsLog Reader" state={appUpdater.state} onInstall={() => void appUpdater.installUpdate()} onDismiss={appUpdater.dismissUpdater} />;

  if (!document && !opening && !parsing) return <div className={`reader-empty-state${desktopMode?" has-titlebar":""}`}>
    <ReaderTitlebar />
    {updateControl}
    <main className="reader-welcome-layout">
      <section className="reader-welcome-primary">
        <ReaderFamilyMark />
        <span className="eyebrow">OPSLOG FAMILY · LOCAL TRACE</span>
        <h1>OpsLog Reader</h1>
        <p>独立的 TRC 日志阅读工具。保留 OpsLog 的折叠、搜索、结构预览和自定义标记能力。</p>
        {openControl}
        <small>文件只在本机读取，不会上传到网络</small>
      </section>
      <aside className="reader-welcome-side">
        {showAssociationGuide && associationStatus
          ? <TrcAssociationGuide status={associationStatus} pending={associating} onAssociate={() => void associateFiles()} onDismiss={dismissAssociationGuide} />
          : <>
            <span className="eyebrow">OPEN WORKFLOW</span>
            <h2>打开方式</h2>
            <ol><li><b>01</b><span>点击“打开 TRC”选择本地日志</span></li><li><b>02</b><span>可选关联扩展名，之后直接双击打开</span></li></ol>
            {associationSummary}
          </>}
      </aside>
    </main>
    {notice && <div className="reader-file-notice" role="alert">{notice}<button onClick={() => setNotice(undefined)}>×</button></div>}
    {updateDialog}
  </div>;

  const headerActions = <>
    {openControl}
    {updateControl}
    {associationStatus?.supported && !associationStatus.associated && <button type="button" className="reader-association-shortcut" disabled={associating} onClick={() => void associateFiles()}>{associating ? "正在关联…" : "关联 .trc"}</button>}
  </>;

  return <div className={`reader-app${desktopMode?" has-titlebar":""}`}>
    <ReaderTitlebar />
    <LogReaderWorkspace
      ref={readerRef}
      logId={document?.name ?? "正在打开 TRC…"}
      content={opening || parsing ? "" : document?.content ?? ""}
      loading={opening || parsing}
      onClose={() => setDocument(undefined)}
      presentation="standalone"
      eyebrow="TRC LOG · LOCAL FILE"
      title="OpsLog Reader"
      sourceLabel="TRC"
      headerAction={headerActions}
    />
    {notice && <div className="reader-file-notice" role="alert">{notice}<button onClick={() => setNotice(undefined)}>×</button></div>}
    {updateDialog}
  </div>;
}
