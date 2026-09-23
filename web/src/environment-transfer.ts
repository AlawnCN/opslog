import { normalizeEnvironmentConfiguration } from "./environment-configuration";
import type { EnvironmentConfiguration } from "./types";

const cloneConfiguration = (source: EnvironmentConfiguration): EnvironmentConfiguration => {
  const normalized = normalizeEnvironmentConfiguration(source);
  return {
    ...normalized,
    sshServers: normalized.sshServers?.map((server) => ({ ...server })),
    sshMonitoredApplications: normalized.sshMonitoredApplications?.map((application) => ({ ...application }))
  };
};

const createUniqueName = (requestedName: string, suffix: string, environments: EnvironmentConfiguration[]): string => {
  const usedNames = new Set(environments.map((item) => item.name.trim().toLocaleLowerCase()));
  const baseName = `${requestedName.trim() || "environment"}-${suffix}`;
  let name = baseName;
  let sequence = 2;
  while (usedNames.has(name.toLocaleLowerCase())) name = `${baseName}-${sequence++}`;
  return name;
};

export const cloneEnvironmentConfiguration = (source: EnvironmentConfiguration, environments: EnvironmentConfiguration[]): EnvironmentConfiguration => {
  return { ...cloneConfiguration(source), name: createUniqueName(source.name, "copy", environments) };
};

const preserveSecrets = (current: EnvironmentConfiguration, imported: EnvironmentConfiguration): EnvironmentConfiguration => ({
  ...imported,
  password: imported.password || current.password,
  sshServers: imported.sshServers?.map((server) => {
    const existing = current.sshServers?.find((item) => item.name.trim().toLocaleLowerCase() === server.name.trim().toLocaleLowerCase());
    return { ...server, password: server.password || existing?.password || "" };
  })
});

export const mergeImportedEnvironments = (current: EnvironmentConfiguration[], imported: EnvironmentConfiguration[], preserveEmptySecrets = true): { environments: EnvironmentConfiguration[]; importedIndexes: number[]; updated: number; added: number } => {
  const next = current.map(cloneConfiguration);
  const importedIndexes: number[] = [];
  let updated = 0;
  let added = 0;
  imported.forEach((candidate) => {
    const normalized = cloneConfiguration(candidate);
    const existingIndex = next.findIndex((item) => item.name.trim().toLocaleLowerCase() === normalized.name.trim().toLocaleLowerCase());
    if (existingIndex >= 0) {
      if (next[existingIndex].sourceType !== normalized.sourceType) {
        importedIndexes.push(next.length);
        next.push({ ...normalized, name: createUniqueName(normalized.name, "imported", next) });
        added += 1;
        return;
      }
      next[existingIndex] = preserveEmptySecrets ? preserveSecrets(next[existingIndex], normalized) : normalized;
      importedIndexes.push(existingIndex);
      updated += 1;
      return;
    }
    importedIndexes.push(next.length);
    next.push(normalized);
    added += 1;
  });
  return { environments: next, importedIndexes, updated, added };
};

export const remapSelectionAfterMove = (selection: Set<number>, from: number, to: number): Set<number> => new Set(Array.from(selection, (index) => {
  if (index === from) return to;
  if (from < to && index > from && index <= to) return index - 1;
  if (to < from && index >= to && index < from) return index + 1;
  return index;
}));

export const remapSelectionAfterRemove = (selection: Set<number>, removed: number): Set<number> => new Set(Array.from(selection).flatMap((index) => index === removed ? [] : [index > removed ? index - 1 : index]));
