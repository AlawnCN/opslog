import type { SVGProps } from "react";

const Icon = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>{children}</svg>
);

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>;
export const DownloadIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16"/></Icon>;
export const MarkdownFileIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M6 2.5h8l4 4V21H6zM14 2.5v4h4"/><text x="12" y="16.5" textAnchor="middle">MD</text></Icon>;
export const HtmlFileIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M6 2.5h8l4 4V21H6zM14 2.5v4h4M10.2 12.2 8.4 14l1.8 1.8m3.6-3.6 1.8 1.8-1.8 1.8M12.9 11l-1.8 6"/></Icon>;
export const TraceIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6.5 8l4.5 8m6.5-8L13 16"/></Icon>;
export const TextReaderIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M5 3h9l4 4v5M14 3v5h4M8 12h4m-4 3h3M5 3v18h8"/><circle cx="15.5" cy="15.5" r="3.5"/><path d="m18 18 3 3"/></Icon>;
export const CloseIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
export const PulseIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M3 12h4l2-6 4 12 2-6h6"/></Icon>;
export const ColumnsIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 5v14m6-14v14"/></Icon>;
export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m7 10 5 5 5-5"/></Icon>;
export const ImportIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 16V4m0 0 5 5m-5-5L7 9M4 14v6h16v-6"/></Icon>;
export const MarkerAddIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M6 4h9a2 2 0 0 1 2 2v14l-6.5-4L4 20V6a2 2 0 0 1 2-2Z"/><path d="M10.5 7v5m-2.5-2.5h5"/></Icon>;
export const MoreIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></Icon>;
export const AiSparkIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m12 2 1.45 5.15L18 9l-4.55 1.85L12 16l-1.45-5.15L6 9l4.55-1.85L12 2Z"/><path d="m18.5 14 .8 2.7L22 17.5l-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7ZM4.5 3l.65 2.35L7.5 6l-2.35.65L4.5 9l-.65-2.35L1.5 6l2.35-.65L4.5 3Z"/></Icon>;
export const SettingsIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.1A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3V9.6h.1A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.38.27.6.65.6 1.1v3.8c0 .45-.22.83-.6 1.1Z"/></Icon>;
