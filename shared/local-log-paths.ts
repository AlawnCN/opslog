export const validLocalDirectory = (directory: string): boolean =>
  !/[\x00-\x1f]/.test(directory) && (directory.startsWith("/") || /^[A-Za-z]:[\\/]/.test(directory) || /^\\\\[^\\]+\\[^\\]+/.test(directory))
  && !directory.split(/[\\/]/).includes("..");
