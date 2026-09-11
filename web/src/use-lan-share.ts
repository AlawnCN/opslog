import { useEffect, useState } from "react";
import { errorMessage, getLanShareStatus, setLanShareEnabled, type LanShareStatus } from "./api";

export interface LanShareController extends LanShareStatus {
  busy: boolean;
  error?: string;
  enable: (requirePasscode: boolean) => Promise<void>;
  disable: () => Promise<void>;
}

export const useLanShare = (enabled: boolean): LanShareController => {
  const [status, setStatus] = useState<LanShareStatus>({ enabled: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enabled) return;
    void getLanShareStatus().then(setStatus).catch((reason) => setError(errorMessage(reason)));
  }, [enabled]);

  const update = async (nextEnabled: boolean, requirePasscode = false) => {
    if (!enabled || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setStatus(await setLanShareEnabled(nextEnabled, requirePasscode));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  return {
    ...status,
    busy,
    error,
    enable: (requirePasscode) => update(true, requirePasscode),
    disable: () => update(false)
  };
};
