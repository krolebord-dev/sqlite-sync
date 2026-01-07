import { queryOptions } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authenticatedMiddleware } from "./auth";
import { db } from "./db";

export const getLists = createServerFn({ method: "GET" })
  .middleware([authenticatedMiddleware])
  .handler(async ({ context }) => {
    const userId = context.auth.userId;
    const lists = await db
      .selectFrom("list as l")
      .innerJoin("user_to_list as utl", "l.id", "utl.listId")
      .where("utl.userId", "=", userId)
      .select(["l.id", "l.name"])
      .execute();
    return lists;
  });

console.log("getListsQuery");
export const getListsQuery = queryOptions({
  queryKey: ["lists"],
  queryFn: getLists,
});

export const userCanAccessListMiddleware = createMiddleware({ type: "function" })
  .middleware([authenticatedMiddleware])
  .inputValidator(z.object({ listId: z.string() }))
  .server(async ({ next, context, data }) => {
    const listId = data.listId;
    const userId = context.auth.userId;
    const list = await db
      .selectFrom("list as l")
      .innerJoin("user_to_list as utl", "l.id", "utl.listId")
      .where("utl.userId", "=", userId)
      .where("l.id", "=", listId)
      .select(["l.id", "l.name"])
      .executeTakeFirst();
    if (!list) {
      throw redirect({ to: "/", params: { id: listId } });
    }
    return next({
      context: {
        list,
      },
    });
  });
