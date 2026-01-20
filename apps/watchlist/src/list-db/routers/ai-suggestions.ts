import z from "zod";
import { listProcedure } from "./orpc-base";

const hello = listProcedure.input(z.string()).handler(async ({ input }) => {
  return `Hello, ${input}!`;
});

export const aiSuggestionsRouter = {
  hello,
};
