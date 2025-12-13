import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { mainSchema } from '../db';
import { listProcedure, protectedProcedure, router } from '../trpc';
import { sendMagicLinkEmail } from './auth.router';

/**
 * List Router
 *
 * This router handles list management operations that stay on the server:
 * - List CRUD (create, read, update, delete lists)
 * - List sharing and user invitations
 * - Tags management (until migrated to sqlite-sync)
 *
 * Item operations (add, update, delete, watched status, priority) are now
 * handled locally via sqlite-sync and synced through the ListSyncServer.
 */
export const listRouter = router({
  // ==========================================
  // List Management (stays on server)
  // ==========================================

  getLists: protectedProcedure.query(async ({ ctx }) => {
    const user = ctx.userSession.user;
    const lists = await ctx.db
      .selectDistinct({
        id: mainSchema.listsTable.id,
        name: mainSchema.listsTable.name,
      })
      .from(mainSchema.listsTable)
      .innerJoin(
        mainSchema.usersToListsTable,
        and(
          eq(mainSchema.usersToListsTable.userId, user.id),
          eq(mainSchema.usersToListsTable.listId, mainSchema.listsTable.id),
        ),
      );

    return lists;
  }),

  createList: protectedProcedure.input(z.object({ name: z.string() })).mutation(async ({ input, ctx }) => {
    const user = ctx.userSession.user;

    const listId = crypto.randomUUID();
    await ctx.db.insert(mainSchema.listsTable).values({
      id: listId,
      name: input.name,
    });

    await ctx.db.insert(mainSchema.usersToListsTable).values({
      userId: user.id,
      listId,
    });

    return { listId };
  }),

  editList: listProcedure.input(z.object({ newName: z.string() })).mutation(async ({ input, ctx }) => {
    await ctx.db
      .update(mainSchema.listsTable)
      .set({
        name: input.newName,
      })
      .where(eq(mainSchema.listsTable.id, input.listId));

    return { listId: input.listId };
  }),

  getDetails: listProcedure.query(async ({ input, ctx }) => {
    const list = await ctx.db.query.listsTable.findFirst({
      where: eq(mainSchema.listsTable.id, input.listId),
      columns: {
        id: true,
        name: true,
        createdAt: true,
      },
      with: {
        usersToLists: {
          with: {
            user: {
              columns: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!list) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }

    const { usersToLists, ...rest } = list;

    return {
      ...rest,
      users: usersToLists.map((user) => user.user),
      // Stats will be computed client-side from local SQLite
      stats: null,
    };
  }),

  inviteUser: listProcedure.input(z.object({ email: z.string() })).mutation(async ({ input, ctx }) => {
    return await sendMagicLinkEmail(ctx, { email: input.email, listId: input.listId });
  }),

  // ==========================================
  // Tags Management (temporarily on server until migrated)
  // ==========================================

  getTags: listProcedure.query(async ({ input, ctx }) => {
    const tags = await ctx.db.query.listTagsTable.findMany({
      where: eq(mainSchema.listTagsTable.listId, input.listId),
      columns: {
        id: true,
        name: true,
      },
    });

    return tags;
  }),

  createTag: listProcedure.input(z.object({ name: z.string().min(1) })).mutation(async ({ input, ctx }) => {
    const tagId = ctx.createId();
    const [tag] = await ctx.db
      .insert(mainSchema.listTagsTable)
      .values({
        id: tagId,
        name: input.name,
        listId: input.listId,
      })
      .returning();

    return { tagId: tag.id };
  }),

  updateTag: listProcedure
    .input(z.object({ tagId: z.string(), name: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      await ctx.db
        .update(mainSchema.listTagsTable)
        .set({ name: input.name })
        .where(and(eq(mainSchema.listTagsTable.id, input.tagId), eq(mainSchema.listTagsTable.listId, input.listId)));
    }),

  deleteTag: listProcedure.input(z.object({ tagId: z.string() })).mutation(async ({ input, ctx }) => {
    await ctx.db
      .delete(mainSchema.listTagsTable)
      .where(and(eq(mainSchema.listTagsTable.id, input.tagId), eq(mainSchema.listTagsTable.listId, input.listId)));
  }),
});
