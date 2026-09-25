import { relaunch } from "@tauri-apps/plugin-process";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { loadUpdateReleaseNotes } from "./api";
import { normalizeReleaseNotes } from "./update-release-notes";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "installing" | "error";

export interface AppUpdateState {
  phase: UpdatePhase;
  visible: boolean;
  version?: string;
  currentVersion?: string;
  notes?: string;
  notesLoading?: boolean;
  notesError?: string;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
}

interface AppUpdaterOptions {
  enabled: boolean;
  onCurrent: () => void;
  onError: (message: string) => void;
}

const initialState: AppUpdateState = {
  phase: "idle",
  visible: false,
  downloadedBytes: 0
};

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface MirrorCandidate {
  version: string;
  currentVersion: string;
  body?: string;
  source: "gitea" | "github";
}

export const useAppUpdater = ({ enabled, onCurrent, onError }: AppUpdaterOptions) => {
  const [state, setState] = useState(initialState);
  const candidate = useRef<MirrorCandidate | undefined>(undefined);
  const checking = useRef(false);

  const checkForUpdates = useCallback(async (manual = true) => {
    if (!enabled || checking.current) return;
    checking.current = true;
    setState((current) => ({ ...current, phase: "checking", visible: manual }));
    try {
      const update = await invoke<MirrorCandidate | null>("check_update_mirrors");
      if (!update) {
        candidate.current = undefined;
        setState(initialState);
        if (manual) onCurrent();
        return;
      }
      candidate.current = update;
      const manifestNotes = normalizeReleaseNotes(update.body);
      setState({
        phase: "available",
        visible: true,
        version: update.version,
        currentVersion: update.currentVersion,
        notes: manifestNotes,
        notesLoading: !manifestNotes,
        downloadedBytes: 0
      });
      if (!manifestNotes) {
        try {
          const releaseNotes = normalizeReleaseNotes(await loadUpdateReleaseNotes(update.version));
          if (candidate.current !== update) return;
          setState((current) => ({
            ...current,
            notes: releaseNotes,
            notesLoading: false,
            notesError: releaseNotes ? undefined : "该版本没有可显示的更新说明。"
          }));
        } catch (error) {
          if (candidate.current !== update) return;
          setState((current) => ({
            ...current,
            notesLoading: false,
            notesError: `完整更新说明暂时读取失败：${messageOf(error)}`
          }));
        }
      }
    } catch (error) {
      candidate.current = undefined;
      setState(initialState);
      if (manual) onError(messageOf(error));
    } finally {
      checking.current = false;
    }
  }, [enabled, onCurrent, onError]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => void checkForUpdates(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [checkForUpdates, enabled]);

  const handleDownloadEvent = (event: DownloadEvent) => {
    if (event.event === "Started") {
      setState((current) => ({ ...current, totalBytes: event.data.contentLength, downloadedBytes: 0 }));
    } else if (event.event === "Progress") {
      setState((current) => ({ ...current, downloadedBytes: current.downloadedBytes + event.data.chunkLength }));
    } else {
      setState((current) => ({ ...current, phase: "installing" }));
    }
  };

  const installUpdate = async () => {
    const update = candidate.current;
    if (!update || state.phase === "downloading" || state.phase === "installing") return;
    setState((current) => ({ ...current, phase: "downloading", visible: true, error: undefined }));
    try {
      const onEvent = new Channel<DownloadEvent>();
      onEvent.onmessage = handleDownloadEvent;
      await invoke("install_update_from_mirrors", {
        version: update.version,
        source: update.source,
        onEvent
      });
      await relaunch();
    } catch (error) {
      setState((current) => ({ ...current, phase: "error", visible: true, error: messageOf(error) }));
    }
  };

  const showUpdater = () => {
    if (candidate.current) {
      setState((current) => ({ ...current, visible: true }));
      return;
    }
    void checkForUpdates(true);
  };

  const dismissUpdater = () => {
    if (state.phase === "downloading" || state.phase === "installing") return;
    setState((current) => ({ ...current, visible: false }));
  };

  return { state, checkForUpdates: showUpdater, installUpdate, dismissUpdater };
};
