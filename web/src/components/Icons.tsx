import type { SVGProps } from "react";

const Icon = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>{children}</svg>
);

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>;
export const DownloadIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16"/></Icon>;
export const MarkdownFileIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M5.5 2.5h8.5l4.5 4.5v14.5h-13zM14 2.5V7h4.5"/><rect x="7.5" y="11" width="9" height="6.5" rx="1"/><text x="12" y="15.8" textAnchor="middle">MD</text></Icon>;
export const HtmlFileIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M5.5 2.5h8.5l4.5 4.5v14.5h-13zM14 2.5V7h4.5"/><path className="file-code-mark" d="m10.5 11.8-2.2 2.2 2.2 2.2m3-4.4 2.2 2.2-2.2 2.2M12.8 10.8l-1.6 6.4"/></Icon>;
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
export const TrashIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M4 7h16M9 3h6l1 4H8l1-4Zm-2 4 1 14h8l1-14M10 11v6m4-6v6"/></Icon>;
export const EyeIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></Icon>;
export const EyeOffIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M3 3 21 21M10.6 6.1A11 11 0 0 1 12 6c6.4 0 10 6 10 6a16 16 0 0 1-3.3 3.7M6.2 6.9C3.5 8.7 2 12 2 12s3.6 6 10 6a11 11 0 0 0 4.1-.8M10 10a3 3 0 0 0 4 4"/></Icon>;
