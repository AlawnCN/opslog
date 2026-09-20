export const DEFAULT_AI_RESPONSE_LANGUAGE = "zh-CN";

export const AI_RESPONSE_LANGUAGE_OPTIONS = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en-US", label: "English" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
  { value: "fr-FR", label: "Français" },
  { value: "de-DE", label: "Deutsch" },
  { value: "es-ES", label: "Español" },
  { value: "pt-BR", label: "Português" },
  { value: "sw-KE", label: "Kiswahili" },
  { value: "ar", label: "العربية" }
] as const;

export const aiResponseLanguageLabel = (value: string): string =>
  AI_RESPONSE_LANGUAGE_OPTIONS.find((option) => option.value === value)?.label ?? value;

export const aiResponseLanguageInstruction = (value: string): string => {
  const label = aiResponseLanguageLabel(value);
  return `回复语言：必须使用 ${label}（${value}）完成全部分析。除日志原文、代码、SQL、字段名、标识符、错误消息和专有名词外，不得切换为其他语言。本要求优先于其他提示词中的固定语言要求。`;
};
