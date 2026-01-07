import { AsyncLocalStorage } from "node:async_hooks";
import { type Context, contextSymbol } from "./context";

(globalThis as any)[contextSymbol] = new AsyncLocalStorage<Context>();
console.log("Registered context storage");
