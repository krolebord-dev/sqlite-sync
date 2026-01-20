import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sql } from "kysely";
import { CheckIcon, MailIcon, PenIcon } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useListId } from "@/lib/use-list";
import { formatDuration } from "@/lib/utils/format-duration";
import { useDbQuery } from "@/list-db/list-db";
import { orpc } from "@/orpc/orpc-client";

type ListSettingsSheetProps = {
  children: React.ReactNode;
  asChild?: boolean;
};

export function ListSettingsSheet({ children, asChild }: ListSettingsSheetProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild={asChild}>{children}</SheetTrigger>
      <SheetContent side="left" showCloseButton={false} onOpenAutoFocus={(e) => e.preventDefault()}>
        <SheetHeader>
          <SheetTitle>List Settings</SheetTitle>
        </SheetHeader>
        <ListSettingsForm />
      </SheetContent>
    </Sheet>
  );
}

function ListSettingsForm() {
  const { data: listStats } = useDbQuery({
    queryFn: (db) => {
      return db
        .selectFrom("item")
        .select(({ fn }) => [
          fn.count<number>("id").as("count"),
          sql<number>`count(case when ${sql.ref("watchedAt")} is not null then 1 end)`.as("watchedCount"),
          sql<number>`sum(${sql.ref("duration")})`.as("totalDuration"),
          sql<number>`sum(case when ${sql.ref("watchedAt")} is not null then ${sql.ref("duration")} else 0 end)`.as(
            "watchedDuration",
          ),
          sql<number>`avg(${sql.ref("rating")})`.as("averageRating"),
        ]);
    },
    mapData: ([listStats]) => listStats,
  });

  const listId = useListId();
  const { data: list } = useQuery(
    // biome-ignore lint/style/noNonNullAssertion: listId is guaranteed to be non-null by the route
    orpc.list.getListWithMembers.queryOptions({ input: { listId: listId! }, enabled: !!listId }),
  );

  return (
    <div className="flex h-full flex-col justify-between gap-12 px-4">
      <div className="flex flex-col gap-12">
        {list ? <ListNameForm listId={list.id} name={list.name} /> : <Skeleton className="h-8 w-full" />}
        {list ? <ListUsers listId={list.id} users={list.members} /> : <Skeleton className="h-8 w-full" />}
      </div>
      {!!listStats && (
        <div className="flex flex-col pb-6 text-gray-500">
          <p>
            Watched: {listStats.watchedCount} / {listStats.count}
          </p>
          <p>
            Duration: {formatDuration(listStats.watchedDuration)} / {formatDuration(listStats.totalDuration)}
          </p>
          <p>Average rating: {Math.round(listStats.averageRating)}</p>
        </div>
      )}
    </div>
  );
}

const editListSchema = z.object({
  name: z.string().min(2),
});

type EditListSchema = z.infer<typeof editListSchema>;

type ListNameFormProps = {
  listId: string;
  name: string;
};
function ListNameForm({ listId, name }: ListNameFormProps) {
  const queryClient = useQueryClient();
  const editListMutation = useMutation(
    orpc.list.editList.mutationOptions({
      onSuccess: (data, { newName }) => {
        if (data.id) {
          queryClient.invalidateQueries({ queryKey: orpc.list.getLists.key() });
          queryClient.invalidateQueries({ queryKey: orpc.list.getList.key({ input: { listId } }) });
          reset({
            name: newName,
          });
        }
      },
    }),
  );

  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty },
  } = useForm<EditListSchema>({
    resolver: zodResolver(editListSchema),
    defaultValues: {
      name,
    },
  });

  const onSubmit = (data: EditListSchema) => {
    editListMutation.mutate({ listId, newName: data.name });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-row gap-2">
      <Input {...register("name")} placeholder="Create a new list" />
      <Button
        type="submit"
        variant="outline"
        disabled={editListMutation.isPending || !isDirty}
        className="aspect-square p-0"
      >
        {editListMutation.isSuccess && !isDirty ? <CheckIcon className="size-4!" /> : <PenIcon className="size-4!" />}
      </Button>
    </form>
  );
}

const emailSchema = z.object({
  email: z.string().email(),
});

type EmailSchema = z.infer<typeof emailSchema>;

type ListUsersProps = {
  listId: string;
  users: {
    id: string;
    name: string;
    email: string;
  }[];
};
function ListUsers({ listId, users }: ListUsersProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { isValid, isDirty },
  } = useForm<EmailSchema>({
    resolver: zodResolver(emailSchema),
    defaultValues: {
      email: "",
    },
  });

  const queryClient = useQueryClient();
  const inviteUserMutation = useMutation(
    orpc.list.inviteUser.mutationOptions({
      onSuccess: (data) => {
        if (data.success) {
          reset();
          queryClient.invalidateQueries({ queryKey: orpc.list.getListWithMembers.key({ input: { listId } }) });
        }
      },
    }),
  );

  const onSubmit = (data: EmailSchema) => {
    inviteUserMutation.mutate({ listId, email: data.email });
  };

  return (
    <div>
      <p>Collaborators</p>
      <div className="h-2" />
      <Table>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="p-2">
                <div className="max-w-[120px] truncate">{user.name}</div>
              </TableCell>
              <TableCell className="p-2">
                <div className="max-w-[180px] truncate">{user.email}</div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="h-2" />
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-row gap-2">
        <Input {...register("email")} placeholder="Invite by email" />
        <Button
          type="submit"
          variant="outline"
          disabled={inviteUserMutation.isPending || !isValid}
          className="aspect-square p-0"
        >
          {inviteUserMutation.isSuccess && !isDirty ? (
            <CheckIcon className="size-4!" />
          ) : (
            <MailIcon className="size-4!" />
          )}
        </Button>
      </form>
    </div>
  );
}
