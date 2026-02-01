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
      .select(["l.id", "l.name", "l.createdBy"])
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

export const getListWithMembers = protectedProcedure
  .input(z.object({ listId: z.string() }))
  .use(canAccessList, (input) => input.listId)
  .handler(async ({ context, input }) => {
    const { list } = context;
    const listId = input.listId;

    // Get members
    const members = await db
      .selectFrom("user_to_list as utl")
      .innerJoin("user as u", "utl.userId", "u.id")
      .where("utl.listId", "=", listId)
      .select(["u.id", "u.name", "u.email"])
      .execute();

    return {
      id: list.id,
      name: list.name,
      createdBy: list.createdBy,
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
      })),
    };
  });

export const createList = protectedProcedure
  .input(z.object({ name: z.string() }))
  .handler(async ({ context, input }) => {
    const userId = context.auth.userId;
    const listId = crypto.randomUUID();
    await db
      .insertInto("list")
      .values({ id: listId, name: input.name, createdAt: new Date().toISOString(), createdBy: userId })
      .execute();
    await db.insertInto("user_to_list").values({ userId, listId }).execute();
    return { success: true, listId };
  });

export const editList = protectedProcedure
  .input(z.object({ listId: z.string(), newName: z.string() }))
  .use(canAccessList, (input) => input.listId)
  .handler(async ({ context, input }) => {
    const { list } = context;
    await db.updateTable("list").set({ name: input.newName }).where("id", "=", list.id).execute();
    return { success: true, id: list.id, name: input.newName };
  });

export const inviteUser = protectedProcedure
  .input(z.object({ listId: z.string(), email: z.email() }))
  .use(canAccessList, (input) => input.listId)
  .handler(async ({ context, input, errors }) => {
    const { list } = context;
    const listId = list.id;

    // Find or create user by email
    const now = new Date().toISOString();
    let user = await db.selectFrom("user").where("email", "=", input.email).selectAll().executeTakeFirst();

    if (user) {
      const existingMember = await db
        .selectFrom("user_to_list")
        .where("userId", "=", user.id)
        .where("listId", "=", listId)
        .selectAll()
        .executeTakeFirst();

      if (existingMember) {
        throw errors.BAD_REQUEST();
      }
    }

    if (!user) {
      const userId = crypto.randomUUID();
      await db
        .insertInto("user")
        .values({
          id: userId,
          name: input.email.split("@")[0],
          email: input.email,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      user = await db.selectFrom("user").where("id", "=", userId).selectAll().executeTakeFirstOrThrow();
    }

    await db.insertInto("user_to_list").values({ userId: user.id, listId }).execute();

    return { success: true };
  });

export const deleteList = protectedProcedure
  .input(z.object({ listId: z.string() }))
  .use(canAccessList, (input) => input.listId)
  .handler(async ({ context, errors }) => {
    const userId = context.auth.userId;
    const { list } = context;

    if (list.createdBy !== userId) {
      throw errors.BAD_REQUEST();
    }

    await db.deleteFrom("list").where("id", "=", list.id).execute();
    return { success: true };
  });

export const listRouter = {
  getLists,
  getList,
  getListWithMembers,
  createList,
  editList,
  inviteUser,
  deleteList,
};
