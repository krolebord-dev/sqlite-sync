import { scan } from "react-scan";
import { StrictMode, Suspense, use } from "react";
import { createRoot } from "react-dom/client";
import { DbProvider, initDb } from "./db.ts";
import { App } from "./App.tsx";

scan({
  enabled: true,
});

const db = initDb();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<Loading />}>
      <Root>
        <App />
      </Root>
    </Suspense>
  </StrictMode>
);

// eslint-disable-next-line react-refresh/only-export-components
function Root({ children }: { children: React.ReactNode }) {
  const _db = use(db) as any;
  return <DbProvider db={_db}>{children}</DbProvider>;
}

// eslint-disable-next-line react-refresh/only-export-components
function Loading() {
  return <div>Loading...</div>;
}
