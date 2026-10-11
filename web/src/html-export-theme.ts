import { normalizeTheme, THEMES } from "./theme";

const tokens = [
  "canvas", "scene", "scene-size", "surface", "surface-solid", "surface-2", "text", "muted", "cyan", "accent-text",
  "line", "selected-surface", "error-surface", "red", "green", "amber", "scrollbar", "backdrop", "radius", "panel-radius",
  "panel-shadow", "control-surface", "control-hover", "control-shadow", "control-hover-shadow", "control-pressed-shadow",
  "input-surface", "input-shadow", "input-focus-shadow", "editor-surface", "font-ui", "font-mono", "syntax-key", "syntax-string", "syntax-number",
  "motion-duration", "motion-easing", "primary-surface", "primary-text", "hover-lift", "press-scale", "focus-color", "hud-panel-background"
];

// Export a material snapshot, not links to app CSS or the recipient's preferences.
export const captureHtmlExportTheme = (): { attributes: string; styles: string } => {
  const theme = normalizeTheme(typeof document === "undefined" ? undefined : document.documentElement.dataset.theme);
  const definition = THEMES.find((candidate) => candidate.value === theme) ?? THEMES[0];
  const attributes = `data-theme="${theme}" data-theme-ui="${theme === "cyberpunk" ? "classic" : "modern"}" data-theme-tone="${definition.tone}"`;
  if (theme === "cyberpunk" || typeof getComputedStyle === "undefined") return { attributes, styles: "" };
  const computed = getComputedStyle(document.documentElement);
  const declarations = tokens.flatMap((token) => {
    const value = computed.getPropertyValue(`--${token}`).trim();
    // CSS values cannot close the style element or introduce additional declarations.
    return value && !/[<>{};]/.test(value) ? [`--${token}:${value}`] : [];
  }).join(";");
  return { attributes, styles: `:root[data-theme-ui="modern"]{${declarations};color-scheme:${definition.tone}}\n${exportThemeStyles}` };
};

const rule = (selectors: string, declarations: string) =>
  `:root[data-theme-ui="modern"] :is(${selectors}){${declarations}}`;

const exportThemeStyles = [
  rule("body", "background:var(--scene,var(--canvas));background-size:var(--scene-size,auto);color:var(--text);font-family:var(--font-ui)"),
  rule(".shell", "background:none"),
  rule(".header,.hero", "background:var(--surface);border-color:var(--line);box-shadow:var(--panel-shadow);border-radius:var(--panel-radius)"),
  rule(".toolbar,.summary,.portable-preview-toolbar,.portable-preview-dialog>header", "background:var(--surface-2);border-color:var(--line)"),
  rule(".viewer,.log-line,.portable-preview-code,.java-object-tree,.content,.content pre", "background:var(--editor-surface);color:var(--text);border-color:var(--line)"),
  rule(".content", "border-radius:var(--panel-radius);box-shadow:var(--panel-shadow)"),
  rule(".gutter,.meta span,.content th", "background:var(--surface-2);color:var(--muted);border-color:var(--line)"),
  rule(".header h1,.hero h1,.content h1,.content h2,.content h3,.portable-preview-dialog>header strong,.outline-head h2,.marker b", "color:var(--text);border-color:var(--line);font-family:var(--font-ui)"),
  rule(".eyebrow,.snapshot-meta,.snapshot-meta b,.match-count,.toggle,.custom-label,.boot,.readonly,.outline-empty,.outline-foot,.portable-preview-toolbar>span,.portable-preview-dialog>header span", "color:var(--muted)"),
  rule("button,.btn,.marker,.log-fold-actions button", "background:var(--control-surface);color:var(--text);border-color:var(--line);border-radius:var(--radius);box-shadow:var(--control-shadow);font-family:var(--font-ui);transition:background-color var(--motion-duration) var(--motion-easing),box-shadow var(--motion-duration) var(--motion-easing)"),
  rule("button:hover:not(:disabled),.marker.active", "background:var(--control-hover);color:var(--accent-text);border-color:var(--cyan);box-shadow:var(--control-hover-shadow)"),
  rule("button:active:not(:disabled)", "box-shadow:var(--control-pressed-shadow)"),
  rule("button:focus-visible,input:focus-visible", "outline:2px solid var(--focus-color,var(--cyan));outline-offset:2px"),
  rule(".search", "background:var(--input-surface);border-color:var(--line);border-radius:var(--radius);box-shadow:var(--input-shadow)"),
  rule(".search:focus-within", "border-color:var(--cyan);box-shadow:var(--input-focus-shadow)"),
  rule(".search input", "background:transparent;color:var(--text);font-family:var(--font-ui)"),
  rule(".outline,.portable-preview-dialog", "background:var(--surface-solid);color:var(--text);border-color:var(--line);border-radius:var(--panel-radius);box-shadow:var(--panel-shadow)"),
  rule(".portable-preview-backdrop", "background:var(--backdrop)"),
  rule(".outline-item,.outline-head,.outline-foot,.fold-chip,.fold-chip button,.content th,.content td,.divider", "color:var(--text);border-color:var(--line)"),
  rule(".outline-item,.fold-chip,.fold-chip button,.java-object-toggle,.portable-preview-code-toggle,.fold-toggle", "background:transparent;box-shadow:none;border-radius:0"),
  rule(".fold-chip button:hover,.java-object-toggle:hover,.portable-preview-code-toggle:hover,.fold-toggle:hover", "background:var(--selected-surface);box-shadow:none;border-radius:0"),
  rule(".portable-preview-ellipsis", "background:var(--surface-2);color:var(--muted);border-color:var(--line)"),
  rule(".outline-item:hover,.java-object-row:hover,.portable-preview-code-row:hover", "background:var(--selected-surface)"),
  rule(".tone-0,.tone-1,.tone-2,.tone-3,.tone-4,.tone-5", "background:var(--surface-2);border-left-color:var(--line)"),
  rule(".brand-mark", "color:var(--accent-text);border-color:var(--line);border-radius:var(--radius);background:var(--control-surface);box-shadow:var(--control-shadow)"),
  rule(".log-id,.outline-line,.outline-detail,.content a,.cm-log-sql-keyword,.cm-log-service-name,.cm-log-trace-key,.cm-log-trace-value", "color:var(--accent-text);text-shadow:none"),
  rule(".cm-log-timestamp,.cm-log-source,.cm-log-level-info,.cm-log-sql-muted,.cm-log-json-punctuation,.cm-log-xml-punctuation,.cm-log-xml-comment,.cm-log-service-entry,.java-object-equals,.java-object-value.is-null", "color:var(--muted)"),
  rule(".cm-log-json-key,.cm-log-xml-tag,.cm-log-xml-name,.cm-log-sql-table,.java-object-field,.java-object-kind,.content code", "color:var(--syntax-key);background:var(--surface-2);border-color:var(--line)"),
  rule(".cm-log-json-string,.cm-log-xml-string,.java-object-value.is-string", "color:var(--syntax-string)"),
  rule(".cm-log-json-number,.cm-log-sql-result-number,.java-object-value.is-number,.java-object-type", "color:var(--syntax-number)"),
  rule(".cm-log-json-literal,.cm-log-xml-attribute,.cm-log-sql-result-literal,.java-object-value.is-boolean", "color:var(--accent-text)"),
  rule(".cm-log-sql-result-key,.java-object-value.is-plain,.content pre code", "color:var(--text);background:transparent"),
  rule(".cm-log-level-warn,.cm-log-message-key,.cm-log-sql-result-label,.cm-log-custom-match,.portable-preview-error", "color:var(--amber);background:var(--surface-2);border-color:var(--amber)"),
  rule(".cm-log-code-success", "color:var(--green)"),
  rule(".cm-log-level-error,.cm-log-exception,.cm-log-code-error,.cm-log-message-info,.marker.error b", "color:var(--red);background:var(--error-surface);border-color:var(--red);text-shadow:none"),
  rule(".content blockquote", "color:var(--muted);border-color:var(--accent-text)"),
  rule(".log-line,.outline-preview,.portable-preview-code-row,.java-object-tree,.content pre,.content code", "font-family:var(--font-mono)"),
  rule("*", "scrollbar-color:var(--scrollbar) var(--canvas)"),
  ':root[data-theme="natural-organic"] :is(.header h1,.hero h1,.content h1,.content h2,.content h3){font-family:Georgia,"Songti SC",serif}',
  ':root[data-theme="shoujo-manga"] :is(.header h1,.hero h1)::after{content:" ❀";color:var(--accent-text);font-weight:400;pointer-events:none}',
  ':root[data-theme="cyber-anime"] :is(.header,.hero){background:var(--hud-panel-background)}',
  ':root[data-theme="cyber-anime"] :is(.header h1,.hero h1){letter-spacing:.08em;text-transform:uppercase}',
  ':root:is([data-theme="glassmorphism"],[data-theme="modern-gradient"],[data-theme="fluent-design"]) :is(.header,.hero){backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}',
  '@media(prefers-reduced-motion:reduce){:root[data-theme-ui="modern"] *{transition:none!important;animation:none!important}}'
].join("\n");
