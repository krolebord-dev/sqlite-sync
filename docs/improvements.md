# Improvements

## 1. Version mismatch reload prompt

**File:** `crdt-sync-remote-source.ts:228-231`

When the client receives events with a schema version higher than its own, it goes offline silently. The user has no indication of why sync stopped or that a reload would fix it.

**Improvement:** Add an `onVersionMismatch` callback to the sync configuration. The library calls it when a schema version mismatch is detected, allowing the app to display a "New version available — please reload" prompt or trigger an automatic reload.

```typescript
createSyncedDb({
  // ...
  onVersionMismatch: ({ localVersion, remoteVersion }) => {
    showReloadPrompt("A new version is available. Please reload the app.");
  },
});
```
