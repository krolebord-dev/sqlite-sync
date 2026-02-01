import { zodResolver } from "@hookform/resolvers/zod";
import { generateId } from "@sqlite-sync/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { sql } from "kysely";
import { CheckIcon, DownloadIcon, MailIcon, PenIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth-client";
import { useListId } from "@/lib/use-list";
import { downloadJson, exportItemsToJson } from "@/lib/utils/export-json";
import { formatDuration } from "@/lib/utils/format-duration";
import { parseImportItemsFromJson } from "@/lib/utils/import-json";
import { UserError } from "@/lib/utils/user-error";
import { useDb, useDbQuery } from "@/list-db/list-db";
import { useListOrpc } from "@/list-db/list-orpc-context";
import { orpc } from "@/orpc/orpc-client";
import { itemWatchProvidersAtom } from "./list-atoms";

type ImportResult = {
  imported: number;
  skipped: number;
};

async function importItemsFromJson(db: ReturnType<typeof useDb>, file: File): Promise<ImportResult> {
  const text = await file.text();
  const items = parseImportItemsFromJson(text);

  const existingTmdbIds = db.db.executeKysely((db) => db.selectFrom("item").select("tmdbId")).rows.map((x) => x.tmdbId);

  const existingSet = new Set(existingTmdbIds);

  const itemsToImport = items.filter((item) => !existingSet.has(item.tmdbId));
  const skippedCount = items.length - itemsToImport.length;

  if (itemsToImport.length === 0) {
    return { imported: 0, skipped: items.length };
  }

  db.db.executeTransaction((db) => {
    for (const item of itemsToImport) {
      db.executeKysely((db) =>
        db.insertInto("item").values({
          id: generateId(),
          ...item,
        }),
      );
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
      <SheetContent
        side="left"
        className="overflow-y-auto"
        showCloseButton={false}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
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
      if (error instanceof UserError) {
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

  const handleExport = () => {
    const items = db.db.executeKysely((db) => db.selectFrom("item").selectAll()).rows;
    const json = exportItemsToJson(items);
    downloadJson(json, "watchlist-export.json");
    toast.success(`Exported ${items.length} items.`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-between gap-12 px-4">
      <div className="flex flex-col gap-12">
        {list ? <ListNameForm listId={list.id} name={list.name} /> : <Skeleton className="h-8 w-full" />}
        {list ? <ListUsers listId={list.id} users={list.members} /> : <Skeleton className="h-8 w-full" />}
        <AiSuggestionsToggle />
        <WatchProvidersSettings />
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
        <Button variant="outline" onClick={handleExport} className="w-full">
          <DownloadIcon className="mr-2 size-4" />
          Export to JSON
        </Button>
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
        {list && <DeleteListButton listId={list.id} createdBy={list.createdBy} />}
      </div>
    </div>
  );
}

function AiSuggestionsToggle() {
  const listOrpc = useListOrpc();

  const { data, isLoading } = useQuery(listOrpc.listSettings.getSettings.queryOptions());

  const queryClient = useQueryClient();
  const mutation = useMutation(
    listOrpc.listSettings.setAiSuggestionsEnabled.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: listOrpc.listSettings.getSettings.key() });
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
        checked={data?.aiSuggestionsEnabled ?? true}
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

type DeleteListButtonProps = {
  listId: string;
  createdBy: string;
};

function DeleteListButton({ listId, createdBy }: DeleteListButtonProps) {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const isCreator = auth.userId === createdBy;

  const deleteListMutation = useMutation(
    orpc.list.deleteList.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.list.getLists.key() });
        toast.success("List deleted.");
        navigate({ to: "/" });
      },
      onError: () => {
        toast.error("Failed to delete list.");
      },
    }),
  );

  if (!isCreator) {
    return null;
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" className="w-full">
          <Trash2Icon className="mr-2 size-4" />
          Delete list
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete list?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the list and all its items for every
            collaborator.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => deleteListMutation.mutate({ listId })}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteListMutation.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function WatchProvidersSettings() {
  const listOrpc = useListOrpc();
  const queryClient = useQueryClient();
  const clearWatchProviders = useSetAtom(itemWatchProvidersAtom);

  const { data: settingsData, isLoading: settingsLoading } = useQuery(listOrpc.listSettings.getSettings.queryOptions());

  const region = settingsData?.watchProviderRegion ?? null;

  const { data: regions } = useQuery(orpc.watchProviders.getRegions.queryOptions());
  const { data: availableProviders } = useQuery(
    orpc.watchProviders.getProviders.queryOptions({ input: { region: region ?? undefined }, enabled: !!region }),
  );

  const setRegionMutation = useMutation(
    listOrpc.listSettings.setWatchProviderRegion.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: listOrpc.listSettings.getSettings.key() });
        clearWatchProviders({});
      },
    }),
  );

  const setFilterMutation = useMutation(
    listOrpc.listSettings.setWatchProviderFilter.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: listOrpc.listSettings.getSettings.key() });
        clearWatchProviders({});
      },
    }),
  );

  const handleRegionChange = (value: string) => {
    setRegionMutation.mutate({ region: value });
  };

  const selectedProviderIds = settingsData?.watchProviderFilter ?? [];

  const handleProviderToggle = (providerId: number, checked: boolean) => {
    const next = checked ? [...selectedProviderIds, providerId] : selectedProviderIds.filter((id) => id !== providerId);
    setFilterMutation.mutate({ providerIds: next });
  };

  if (settingsLoading) {
    return <Skeleton className="h-6 w-full" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="font-medium text-sm">Watch Providers</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="watch-region" className="text-muted-foreground text-xs">
          Region
        </Label>
        <Select value={region ?? ""} onValueChange={handleRegionChange} disabled={setRegionMutation.isPending}>
          <SelectTrigger id="watch-region" className="w-full">
            <SelectValue placeholder="Select region" />
          </SelectTrigger>
          <SelectContent>
            {regions?.map((r) => (
              <SelectItem key={r.iso_3166_1} value={r.iso_3166_1}>
                {r.english_name} ({r.iso_3166_1})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {region && availableProviders && availableProviders.length > 0 && (
        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">Providers to show</Label>
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border p-2">
            {availableProviders.map((provider) => (
              <Label
                key={provider.providerId}
                htmlFor={`provider-${provider.providerId}`}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 font-normal hover:bg-accent"
              >
                <Checkbox
                  id={`provider-${provider.providerId}`}
                  checked={selectedProviderIds.includes(provider.providerId)}
                  onCheckedChange={(checked) => handleProviderToggle(provider.providerId, !!checked)}
                />
                <img
                  src={`https://image.tmdb.org/t/p/original${provider.logoPath}`}
                  alt={provider.providerName}
                  className="size-5 rounded"
                  draggable={false}
                />
                <span className="truncate text-sm">{provider.providerName}</span>
              </Label>
            ))}
          </div>
          {selectedProviderIds.length > 0 && (
            <p className="text-muted-foreground text-xs">{selectedProviderIds.length} selected</p>
          )}
        </div>
      )}
    </div>
  );
}
