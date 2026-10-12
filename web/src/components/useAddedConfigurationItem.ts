import { useLayoutEffect, useRef } from "react";

// Reveal only explicit add actions, never ordinary edits or imported data.
export const useAddedConfigurationItem = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const pending = useRef<string | undefined>(undefined);
  const highlighted = useRef<HTMLElement | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealAdded = (selector: string) => { pending.current = selector; };
  useLayoutEffect(() => {
    if (!pending.current) return;
    const item = containerRef.current?.querySelector<HTMLElement>(pending.current);
    pending.current = undefined;
    if (!item) return;
    highlighted.current?.removeAttribute("data-added-item");
    clearTimeout(timer.current);
    if (item instanceof HTMLDetailsElement) item.open = true;
    const input = item.querySelector<HTMLElement>("[data-new-item-focus]") ?? item.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])");
    input?.focus({ preventScroll: true });
    item.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start", inline: "nearest" });
    item.setAttribute("data-added-item", "true");
    highlighted.current = item;
    timer.current = setTimeout(() => { item.removeAttribute("data-added-item"); highlighted.current = undefined; }, 1800);
  });
  useLayoutEffect(() => () => { clearTimeout(timer.current); }, []);
  return { containerRef, revealAdded };
};
