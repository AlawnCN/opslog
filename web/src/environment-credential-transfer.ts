import { normalizeEnvironmentConfiguration, parseEnvironmentConfigurationFile, serializeEnvironmentConfigurations } from "./environment-configuration";
import type { EnvironmentConfiguration } from "./types";

const FORMAT = "opslog-environments-encrypted";
const VERSION = 2;
const ITERATIONS = 600_000;
export const MIN_EXPORT_PASSPHRASE_LENGTH = 8;
const MAX_CIPHERTEXT_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

interface EncryptionParameters {
  algorithm: "AES-256-GCM";
  kdf: "PBKDF2-SHA-256";
  iterations: number;
}

interface LegacyEncryptedSecrets extends EncryptionParameters {
  salt: string;
  iv: string;
  ciphertext: string;
}

interface EncryptedCredential {
  environmentIndex: number;
  kind: "elk" | "ssh";
  serverIndex?: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

type CredentialPassword = Pick<EncryptedCredential, "environmentIndex" | "kind" | "serverIndex"> & { password: string };

interface EncryptedSecrets extends EncryptionParameters {
  entries: EncryptedCredential[];
}

interface LegacyEncryptedEnvironmentTransfer {
  format: typeof FORMAT;
  version: 1;
  environments: Record<string, unknown>[];
  encryptedSecrets: LegacyEncryptedSecrets;
}

interface CurrentEncryptedEnvironmentTransfer {
  format: typeof FORMAT;
  version: typeof VERSION;
  environments: Record<string, unknown>[];
  encryptedSecrets: EncryptedSecrets;
}

export type EncryptedEnvironmentTransfer = LegacyEncryptedEnvironmentTransfer | CurrentEncryptedEnvironmentTransfer;

export type EnvironmentTransfer =
  | { encrypted: false; environments: EnvironmentConfiguration[] }
  | { encrypted: true; file: EncryptedEnvironmentTransfer };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
};

const fromBase64 = (value: string, maxBytes: number): Uint8Array => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error("加密配置文件格式不正确");
  let binary: string;
  try { binary = atob(value); } catch { throw new Error("加密配置文件格式不正确"); }
  if (binary.length > maxBytes) throw new Error("加密配置文件超过大小限制");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const browserCrypto = (): Crypto => {
  if (!globalThis.crypto?.subtle) throw new Error("当前页面不支持安全加密；请通过 HTTPS、localhost 或桌面版导入导出含密码配置");
  return globalThis.crypto;
};

const deriveKey = async (passphrase: string, salt: Uint8Array, iterations: number, usages: KeyUsage[]): Promise<CryptoKey> => {
  const subtle = browserCrypto().subtle;
  const baseKey = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, baseKey, { name: "AES-GCM", length: 256 }, false, usages);
};

const credentialId = (entry: Pick<EncryptedCredential, "environmentIndex" | "kind" | "serverIndex">): string =>
  entry.kind === "elk" ? `elk:${entry.environmentIndex}` : `ssh:${entry.environmentIndex}:${entry.serverIndex}`;

const authenticatedCredential = (environments: Record<string, unknown>[], credentialIds: string[], entry: Pick<EncryptedCredential, "environmentIndex" | "kind" | "serverIndex">): Uint8Array =>
  encoder.encode(JSON.stringify({ format: FORMAT, version: VERSION, environments, credentialIds, credential: credentialId(entry) }));

const validateCredentialEntries = (environments: Record<string, unknown>[], entries: unknown): EncryptedCredential[] => {
  if (!Array.isArray(entries) || !entries.length || entries.length > 1000) throw new Error("加密配置中的密码清单无效");
  const eligible = new Set<string>();
  environments.forEach((environment, environmentIndex) => {
    if (environment.sourceType === "elk") eligible.add(`elk:${environmentIndex}`);
    if (environment.sourceType === "ssh" && Array.isArray(environment.sshServers)) environment.sshServers.forEach((server, serverIndex) => {
      if (isRecord(server) && server.authentication === "password") eligible.add(`ssh:${environmentIndex}:${serverIndex}`);
    });
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry) || !Number.isInteger(entry.environmentIndex) || (entry.kind !== "elk" && entry.kind !== "ssh") ||
      (entry.kind === "ssh" && !Number.isInteger(entry.serverIndex)) || (entry.kind === "elk" && entry.serverIndex !== undefined) ||
      typeof entry.salt !== "string" || typeof entry.iv !== "string" || typeof entry.ciphertext !== "string") throw new Error("加密配置中的密码清单无效");
    const id = credentialId(entry as unknown as EncryptedCredential);
    if (!eligible.has(id) || seen.has(id)) throw new Error("加密配置中的密码清单与连接配置不匹配");
    if (fromBase64(entry.salt, 16).length !== 16 || fromBase64(entry.iv, 12).length !== 12 || fromBase64(entry.ciphertext, MAX_CIPHERTEXT_BYTES).length < 16) throw new Error("加密配置文件格式不正确");
    seen.add(id);
  }
  return entries as EncryptedCredential[];
};

const hasPlaintextPasswords = (environments: Record<string, unknown>[]): boolean => environments.some((environment) =>
  (environment.password != null && environment.password !== "") || (Array.isArray(environment.sshServers) && environment.sshServers.some((server) => isRecord(server) && server.password != null && server.password !== "")));

export const parseEnvironmentTransfer = (contents: string): EnvironmentTransfer => {
  let parsed: unknown;
  try { parsed = JSON.parse(contents) as unknown; } catch { throw new Error("JSON 格式不正确，请检查文件内容"); }
  if (Array.isArray(parsed)) return { encrypted: false, environments: parseEnvironmentConfigurationFile(contents) };
  if (!isRecord(parsed) || parsed.format !== FORMAT || (parsed.version !== 1 && parsed.version !== VERSION) || !Array.isArray(parsed.environments) || !parsed.environments.length || !parsed.environments.every(isRecord) || !isRecord(parsed.encryptedSecrets)) {
    throw new Error("不支持的环境配置文件格式");
  }
  const secrets = parsed.encryptedSecrets;
  if (secrets.algorithm !== "AES-256-GCM" || secrets.kdf !== "PBKDF2-SHA-256" || secrets.iterations !== ITERATIONS) {
    throw new Error("不支持的加密配置格式或参数");
  }
  if (hasPlaintextPasswords(parsed.environments)) throw new Error("加密配置文件包含明文密码，已拒绝导入");
  if (parsed.version === 1) {
    if (typeof secrets.salt !== "string" || typeof secrets.iv !== "string" || typeof secrets.ciphertext !== "string" ||
      fromBase64(secrets.salt, 16).length !== 16 || fromBase64(secrets.iv, 12).length !== 12 || fromBase64(secrets.ciphertext, MAX_CIPHERTEXT_BYTES).length < 16) throw new Error("加密配置文件格式不正确");
  } else {
    validateCredentialEntries(parsed.environments, secrets.entries);
  }
  return { encrypted: true, file: parsed as unknown as EncryptedEnvironmentTransfer };
};

export const serializeEncryptedEnvironmentConfigurations = async (items: EnvironmentConfiguration[], passphrase: string): Promise<string> => {
  if (passphrase.length < MIN_EXPORT_PASSPHRASE_LENGTH) throw new Error(`加密口令至少需要 ${MIN_EXPORT_PASSPHRASE_LENGTH} 个字符`);
  const crypto = browserCrypto();
  const environments = JSON.parse(serializeEnvironmentConfigurations(items)) as Record<string, unknown>[];
  const credentials: CredentialPassword[] = [];
  items.forEach((item, environmentIndex) => {
    const normalized = normalizeEnvironmentConfiguration(item);
    if (normalized.sourceType === "elk") {
      if (normalized.password) credentials.push({ environmentIndex, kind: "elk", password: normalized.password });
      return;
    }
    normalized.sshServers?.forEach((server, serverIndex) => {
      if (server.authentication === "password" && server.password) credentials.push({ environmentIndex, kind: "ssh", serverIndex, password: server.password });
    });
  });
  if (!credentials.length) throw new Error("所选环境没有需要导出的连接密码；请关闭“包含密码”后导出");
  const credentialIds = credentials.map(credentialId);
  const entries: EncryptedCredential[] = [];
  for (const credential of credentials) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt, ITERATIONS, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: authenticatedCredential(environments, credentialIds, credential) as BufferSource }, key, encoder.encode(credential.password) as BufferSource);
    entries.push({ environmentIndex: credential.environmentIndex, kind: credential.kind, ...(credential.kind === "ssh" ? { serverIndex: credential.serverIndex } : {}), salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) });
  }
  const file: CurrentEncryptedEnvironmentTransfer = {
    format: FORMAT, version: VERSION, environments,
    encryptedSecrets: { algorithm: "AES-256-GCM", kdf: "PBKDF2-SHA-256", iterations: ITERATIONS, entries }
  };
  return JSON.stringify(file, null, 2);
};

export const decryptEnvironmentConfigurations = async (file: EncryptedEnvironmentTransfer, passphrase: string): Promise<EnvironmentConfiguration[]> => {
  if (file.version === VERSION) {
    const crypto = browserCrypto();
    const entries = validateCredentialEntries(file.environments, file.encryptedSecrets.entries);
    const credentialIds = entries.map(credentialId);
    const environments = parseEnvironmentConfigurationFile(JSON.stringify(file.environments));
    for (const entry of entries) {
      const salt = fromBase64(entry.salt, 16);
      const iv = fromBase64(entry.iv, 12);
      const key = await deriveKey(passphrase, salt, file.encryptedSecrets.iterations, ["decrypt"]);
      let password: string;
      try {
        const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: authenticatedCredential(file.environments, credentialIds, entry) as BufferSource }, key, fromBase64(entry.ciphertext, MAX_CIPHERTEXT_BYTES) as BufferSource);
        password = decoder.decode(decrypted);
      } catch { throw new Error("密钥错误或加密配置文件已损坏"); }
      if (!password) throw new Error("加密配置中的连接密码为空");
      const environment = environments[entry.environmentIndex];
      if (entry.kind === "elk") environment.password = password;
      else environment.sshServers![entry.serverIndex!].password = password;
    }
    return environments;
  }
  const crypto = browserCrypto();
  const salt = fromBase64(file.encryptedSecrets.salt, 16);
  const iv = fromBase64(file.encryptedSecrets.iv, 12);
  const ciphertext = fromBase64(file.encryptedSecrets.ciphertext, MAX_CIPHERTEXT_BYTES);
  const key = await deriveKey(passphrase, salt, file.encryptedSecrets.iterations, ["decrypt"]);
  let passwords: unknown;
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(JSON.stringify({ format: FORMAT, version: 1, environments: file.environments })) as BufferSource }, key, ciphertext as BufferSource);
    passwords = JSON.parse(decoder.decode(decrypted)) as unknown;
  } catch { throw new Error("密钥错误或加密配置文件已损坏"); }
  const environments = parseEnvironmentConfigurationFile(JSON.stringify(file.environments));
  if (!Array.isArray(passwords) || passwords.length !== environments.length) throw new Error("加密配置中的密码数据与环境列表不匹配");
  return environments.map((environment, index) => {
    const entry: unknown = passwords[index];
    if (!isRecord(entry)) throw new Error("加密配置中的密码数据与环境列表不匹配");
    const password = entry.password;
    const sshPasswords = entry.sshPasswords;
    if (typeof password !== "string" || !Array.isArray(sshPasswords) || sshPasswords.length !== environment.sshServers?.length || !sshPasswords.every((sshPassword) => typeof sshPassword === "string")) {
      throw new Error("加密配置中的密码数据与环境列表不匹配");
    }
    return { ...environment, password, sshServers: environment.sshServers?.map((server, serverIndex) => ({ ...server, password: sshPasswords[serverIndex] as string })) };
  });
};
