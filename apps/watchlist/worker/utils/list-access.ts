import { and, eq } from 'drizzle-orm';
import { type MainDb, mainSchema } from '../main/db';

export async function checkListAccess(db: MainDb, listId: string, userId: string) {
  const list = await db
    .select({
      listId: mainSchema.usersToListsTable.listId,
      userId: mainSchema.usersToListsTable.userId,
    })
    .from(mainSchema.usersToListsTable)
    .where(and(eq(mainSchema.usersToListsTable.userId, userId), eq(mainSchema.usersToListsTable.listId, listId)))
    .limit(1);

  return list.length > 0;
}
