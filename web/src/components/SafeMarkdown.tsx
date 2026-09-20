import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface SafeMarkdownProps {
  source: string;
  imageLabel?: string;
}

const externalUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export const SafeMarkdown = ({ source, imageLabel = "图片" }: SafeMarkdownProps) => <ReactMarkdown
  remarkPlugins={[remarkGfm]}
  skipHtml
  components={{
    a: ({ href, children }) => {
      const safeHref = externalUrl(href);
      return safeHref
        ? <a href={safeHref} target="_blank" rel="noreferrer noopener">{children}</a>
        : <span>{children}</span>;
    },
    img: ({ alt }) => <span>{alt ? `[${imageLabel}：${alt}]` : `[${imageLabel}]`}</span>,
    table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>
  }}
>{source}</ReactMarkdown>;
