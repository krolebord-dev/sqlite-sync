import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import cssText from "./devtools.css?inline";

export function ShadowRoot({ children, className }: { children: ReactNode; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    setShadowRoot(host.shadowRoot ?? host.attachShadow({ mode: "open" }));
  }, []);

  return (
    <div ref={hostRef} className={className}>
      {shadowRoot
        ? createPortal(
            <>
              <style>{cssText}</style>
              {children}
            </>,
            shadowRoot,
          )
        : null}
    </div>
  );
}
