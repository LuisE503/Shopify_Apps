import { useEffect, useRef } from "react";

/** Muestra la Save Bar oficial del admin solo mientras hay cambios sin guardar. */
export function useSaveBar(shopify, id, isDirty) {
  useEffect(() => {
    if (isDirty) {
      shopify.saveBar.show(id);
    } else {
      shopify.saveBar.hide(id);
    }
  }, [shopify, id, isDirty]);

  useEffect(() => () => shopify.saveBar.hide(id), [shopify, id]);
}

/** Ctrl+S (⌘S en Mac) ejecuta `handler`; con null no hace nada. */
export function useSaveShortcut(handler) {
  // El atajo siempre debe llamar a la versión más reciente del handler
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        ref.current?.();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
