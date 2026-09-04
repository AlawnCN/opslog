import type { SVGProps } from "react";

const Icon = ({ children, ...props }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>{children}</svg>
);

export const SearchIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></Icon>;
export const DownloadIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 3v12m0 0 5-5m-5 5-5-5M4 20h16"/></Icon>;
export const TraceIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="M7 6h10M6.5 8l4.5 8m6.5-8L13 16"/></Icon>;
export const TextReaderIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M5 3h9l4 4v5M14 3v5h4M8 12h4m-4 3h3M5 3v18h8"/><circle cx="15.5" cy="15.5" r="3.5"/><path d="m18 18 3 3"/></Icon>;
export const CloseIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
export const PulseIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M3 12h4l2-6 4 12 2-6h6"/></Icon>;
export const ColumnsIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 5v14m6-14v14"/></Icon>;
export const ChevronIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="m7 10 5 5 5-5"/></Icon>;
export const ImportIcon = (props: SVGProps<SVGSVGElement>) => <Icon {...props}><path d="M12 16V4m0 0 5 5m-5-5L7 9M4 14v6h16v-6"/></Icon>;
