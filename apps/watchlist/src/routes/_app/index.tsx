import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { PlusIcon } from "lucide-react";
import { useForm } from "react-hook-form";
import z from "zod";
import { AppHeader, ProjectSelector, UserAvatarDropdown } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authenticatedMiddleware } from "@/lib/auth";
import { db } from "@/lib/db";
import { getListsQuery } from "@/lib/lists";

export const Route = createFileRoute("/_app/")({
  component: RouteComponent,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(getListsQuery);
  },
});

function RouteComponent() {
  return (
    <>
      <AppHeader>
        <h1 className="font-bold text-2xl">watchlist</h1>
        <UserAvatarDropdown />
      </AppHeader>
      <div className="flex flex-col items-center gap-6 pt-6 sm:pt-14">
        <div className="flex flex-col gap-2">
          <p className="text-center font-semibold">Select a list</p>
          <ProjectSelector showCreate={false} />
        </div>
        <p>or</p>
        <CreateListForm />
      </div>
    </>
  );
}

const createListSchema = z.object({
  name: z.string().min(2),
});

type CreateListSchema = z.infer<typeof createListSchema>;

const createList = createServerFn({ method: "POST" })
  .middleware([authenticatedMiddleware])
  .inputValidator(createListSchema)
  .handler(async ({ context, data }) => {
    const userId = context.auth.userId;
    const listId = crypto.randomUUID();
    await db.insertInto("list").values({ id: listId, name: data.name, createdAt: new Date().toISOString() }).execute();
    await db.insertInto("user_to_list").values({ userId, listId }).execute();

    return { success: true, listId };
  });

function CreateListForm() {
  const navigate = useNavigate();

  const queryClient = useQueryClient();
  const createListMutation = useMutation({
    mutationFn: (name: string) => createList({ data: { name } }),
    onSuccess: (data) => {
      if (data.listId) {
        queryClient.invalidateQueries({ queryKey: getListsQuery.queryKey });
        navigate({ to: "/list/$id", params: { id: data.listId } });
      }
    },
  });
  const { register, handleSubmit } = useForm<CreateListSchema>({
    resolver: zodResolver(createListSchema),
  });

  const onSubmit = (data: CreateListSchema) => {
    createListMutation.mutate(data.name);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-row gap-2">
      <Input {...register("name")} placeholder="Create a new list" />
      <Button type="submit" disabled={createListMutation.isPending} className="aspect-square p-0">
        <PlusIcon className="size-6!" />
      </Button>
    </form>
  );
}
