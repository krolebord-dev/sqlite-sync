import { redirect } from "@tanstack/react-router";
import { z } from "zod";
import { db } from "@/lib/db";
import { osBase } from "../common/os";
import { protectedProcedure } from "../common/procedure";

const canAccessList = osBase
  .$context<{
    auth: { userId: string };
  }>()
  .middleware(async ({ context, next }, listId: string) => {
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

export const getLists = protectedProcedure.handler(async ({ context }) => {
  const userId = context.auth.userId;
  const lists = await db
    .selectFrom("list as l")
    .innerJoin("user_to_list as utl", "l.id", "utl.listId")
    .where("utl.userId", "=", userId)
    .select(["l.id", "l.name"])
    .execute();
  return lists;
});

export const getList = protectedProcedure
  .input(z.object({ listId: z.string() }))
  .use(canAccessList, (input) => input.listId)
  .handler(async ({ context }) => {
    return context.list;
  });

export const createList = protectedProcedure
  .input(z.object({ name: z.string() }))
  .handler(async ({ context, input }) => {
    const userId = context.auth.userId;
    const listId = crypto.randomUUID();
    await db.insertInto("list").values({ id: listId, name: input.name, createdAt: new Date().toISOString() }).execute();
    await db.insertInto("user_to_list").values({ userId, listId }).execute();
    return { success: true, listId };
  });

export const listRouter = {
  getLists,
  getList,
  createList,
};
