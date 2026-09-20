import React from "react";
import { SafeMarkdown } from "./SafeMarkdown";

interface ReleaseNotesMarkdownProps {
  notes: string;
}

export const ReleaseNotesMarkdown = ({ notes }: ReleaseNotesMarkdownProps) => <SafeMarkdown source={notes} />;
