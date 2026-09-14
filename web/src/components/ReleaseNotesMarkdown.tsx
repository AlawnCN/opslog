import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ReleaseNotesMarkdownProps {
  notes: string;
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

export const ReleaseNotesMarkdown = ({ notes }: ReleaseNotesMarkdownProps) => <ReactMarkdown
  remarkPlugins={[remarkGfm]}
  skipHtml
  components={{
    a: ({ href, children }) => {
      const safeHref = externalUrl(href);
      return safeHref
        ? <a href={safeHref} target="_blank" rel="noreferrer noopener">{children}</a>
        : <span>{children}</span>;
    },
    img: ({ alt }) => <span className="update-notes-image">{alt ? `[图片：${alt}]` : "[图片]"}</span>
  }}
>{notes}</ReactMarkdown>;
