import { AsyncLocalStorage } from "node:async_hooks";
import { type Context, contextSymbol } from "./context";

if (!(globalThis as any)[contextSymbol]) {
  (globalThis as any)[contextSymbol] = new AsyncLocalStorage<Context>();
  console.log("Registered context storage");
}
