import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

interface DialogOffset { x: number; y: number }
interface DragState extends DialogOffset { pointerX: number; pointerY: number }

interface MovableDialogBinding<ElementType extends HTMLElement> {
  dialogRef: RefObject<ElementType | null>;
  dialogStyle: CSSProperties;
  startMove: (event: ReactPointerEvent<HTMLElement>) => void;
}

const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest("button, input, textarea, select, a, [role='button'], [data-dialog-no-drag]"));

export const useMovableDialog = <ElementType extends HTMLElement>(): MovableDialogBinding<ElementType> => {
  const dialogRef = useRef<ElementType>(null);
  const dragRef = useRef<DragState | undefined>(undefined);
  const [offset, setOffset] = useState<DialogOffset>({ x: 0, y: 0 });
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    if (!moving) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      const dialog = dialogRef.current;
      if (!drag || !dialog) return;
      const proposed = { x: drag.x + event.clientX - drag.pointerX, y: drag.y + event.clientY - drag.pointerY };
      const bounds = dialog.getBoundingClientRect();
      const baseLeft = bounds.left - offset.x;
      const baseTop = bounds.top - offset.y;
      setOffset({
        x: Math.min(window.innerWidth - 48 - baseLeft, Math.max(48 - bounds.width - baseLeft, proposed.x)),
        y: Math.min(window.innerHeight - 40 - baseTop, Math.max(16 - baseTop, proposed.y))
      });
    };
    const stop = () => { dragRef.current = undefined; setMoving(false); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [moving, offset.x, offset.y]);

  const startMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) return;
    event.preventDefault();
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, ...offset };
    setMoving(true);
  };

  return {
    dialogRef,
    dialogStyle: { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` },
    startMove
  };
};
