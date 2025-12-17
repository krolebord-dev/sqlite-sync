import { StrictMode, Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import { scan } from "react-scan";
import { App } from "./App";
import { DbProvider, initDb } from "./db";

scan({
  enabled: true,
});

const db = initDb();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}
createRoot(rootElement).render(
  <StrictMode>
    <Suspense fallback={<Loading />}>
      <Root>
        <App />
      </Root>
    </Suspense>
  </StrictMode>,
);

function Root({ children }: { children: React.ReactNode }) {
  const _db = use(db) as any;
  return <DbProvider db={_db}>{children}</DbProvider>;
}

function Loading() {
  return <div>Loading...</div>;
}
