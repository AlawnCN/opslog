export interface SshHostKeyChallenge {
  host: string;
  port: number;
  fingerprint: string;
}

export const parseSshHostKeyChallenge = (message: string): SshHostKeyChallenge | undefined => {
  const match = /SSH_HOST_KEY_REQUIRED\|([^|\s]+)\|(\d{1,5})\|(SHA256:[A-Za-z0-9+/]{43})/.exec(message);
  if (!match) return undefined;
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? { host: match[1]!, port, fingerprint: match[3]! } : undefined;
};
