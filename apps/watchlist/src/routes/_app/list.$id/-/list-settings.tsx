import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { sql } from "kysely";
import { CheckIcon, MailIcon, PenIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useListId } from "@/lib/use-list";
import { formatDuration } from "@/lib/utils/format-duration";
import { importSchema, transformImportItem } from "@/lib/utils/import-json";
import { useDb, useDbQuery } from "@/list-db/list-db";
import { useListOrpc } from "@/list-db/list-orpc-context";
import { orpc } from "@/orpc/orpc-client";

type ImportResult = {
  imported: number;
  skipped: number;
};

async function importItemsFromJson(db: ReturnType<typeof useDb>, file: File): Promise<ImportResult> {
  const text = await file.text();
  const json = JSON.parse(text);

  const parseResult = importSchema.safeParse(json);
  if (!parseResult.success) {
    throw new Error("Invalid JSON format. Please check the file structure.");
  }

  const items = parseResult.data;

  if (items.length === 0) {
    throw new Error("No items found in the file.");
  }

  const existingTmdbIds = db.db.executeKysely((db) => db.selectFrom("item").select("tmdbId")).rows.map((x) => x.tmdbId);

  const existingSet = new Set(existingTmdbIds);

  const itemsToImport = items.filter((item) => !existingSet.has(item.tmdbId));
  const skippedCount = items.length - itemsToImport.length;

  if (itemsToImport.length === 0) {
    return { imported: 0, skipped: items.length };
  }

  const dbItems = itemsToImport.map(transformImportItem);
  db.db.executeTransaction((db) => {
    for (const item of dbItems) {
      db.executeKysely((db) => db.insertInto("item").values(item));
    }
  });

  return { imported: itemsToImport.length, skipped: skippedCount };
}

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
  const db = useDb();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: listStats } = useDbQuery(
    (db) =>
      db
        .selectFrom("item")
        .select(({ fn }) => [
          fn.count<number>("id").as("count"),
          sql<number>`count(case when ${sql.ref("watchedAt")} is not null then 1 end)`.as("watchedCount"),
          sql<number>`sum(${sql.ref("duration")})`.as("totalDuration"),
          sql<number>`sum(case when ${sql.ref("watchedAt")} is not null then ${sql.ref("duration")} else 0 end)`.as(
            "watchedDuration",
          ),
          sql<number>`avg(${sql.ref("rating")})`.as("averageRating"),
        ]),
    {
      mapData: ([listStats]) => listStats,
    },
  );

  const listId = useListId();
  const { data: list } = useQuery(
    // biome-ignore lint/style/noNonNullAssertion: listId is guaranteed to be non-null by the route
    orpc.list.getListWithMembers.queryOptions({ input: { listId: listId! }, enabled: !!listId }),
  );

  const importMutation = useMutation({
    mutationFn: (file: File) => importItemsFromJson(db, file),
    onSuccess: (result) => {
      if (result.imported === 0) {
        toast.info(`All ${result.skipped} items already exist in your list.`);
      } else if (result.skipped > 0) {
        toast.success(`Imported ${result.imported} items. ${result.skipped} duplicates skipped.`);
      } else {
        toast.success(`Successfully imported ${result.imported} items.`);
      }
    },
    onError: (error) => {
      if (error instanceof SyntaxError) {
        toast.error("Invalid JSON file. Please check the file format.");
      } else if (error instanceof Error) {
        toast.error(error.message);
      } else {
        toast.error("Failed to import items. Please try again.");
      }
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = "";
    importMutation.mutate(file);
  };

  return (
    <div className="flex h-full flex-col justify-between gap-12 px-4">
      <div className="flex flex-col gap-12">
        {list ? <ListNameForm listId={list.id} name={list.name} /> : <Skeleton className="h-8 w-full" />}
        {list ? <ListUsers listId={list.id} users={list.members} /> : <Skeleton className="h-8 w-full" />}
        <AiSuggestionsToggle />
      </div>
      <div className="flex flex-col gap-4 pb-6">
        {!!listStats && (
          <div className="flex flex-col text-gray-500">
            <p>
              Watched: {listStats.watchedCount} / {listStats.count}
            </p>
            <p>
              Duration: {formatDuration(listStats.watchedDuration)} / {formatDuration(listStats.totalDuration)}
            </p>
            <p>Average rating: {Math.round(listStats.averageRating)}</p>
          </div>
        )}
        <Button
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={importMutation.isPending}
          className="w-full"
        >
          <UploadIcon className="mr-2 size-4" />
          {importMutation.isPending ? "Importing..." : "Import from JSON"}
        </Button>
        <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileSelect} />
      </div>
    </div>
  );
}

function AiSuggestionsToggle() {
  const listOrpc = useListOrpc();

  const { data, isLoading } = useQuery(listOrpc.listSettings.getAiSuggestionsEnabled.queryOptions());

  const queryClient = useQueryClient();
  const mutation = useMutation(
    listOrpc.listSettings.setAiSuggestionsEnabled.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: listOrpc.listSettings.getAiSuggestionsEnabled.key() });
      },
    }),
  );

  const handleCheckedChange = (checked: boolean) => {
    mutation.mutate({ enabled: checked });
  };

  if (isLoading) {
    return <Skeleton className="h-6 w-full" />;
  }

  return (
    <div className="flex items-start gap-4">
      <Label htmlFor="ai-suggestions" className="cursor-pointer">
        Auto suggest tags
      </Label>
      <Switch
        id="ai-suggestions"
        checked={data?.enabled ?? true}
        onCheckedChange={handleCheckedChange}
        disabled={mutation.isPending}
      />
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
