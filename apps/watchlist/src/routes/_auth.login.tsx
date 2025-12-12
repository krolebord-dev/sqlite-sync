import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/trpc';

export const Route = createFileRoute('/_auth/login')({
  component: RouteComponent,
});

const emailSchema = z.object({
  email: z.string().email(),
});

type EmailFormSchema = z.infer<typeof emailSchema>;

function RouteComponent() {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<EmailFormSchema>({
    resolver: zodResolver(emailSchema),
  });

  const navigate = useNavigate();

  const sendLinkMutation = trpc.auth.sendMagicLink.useMutation({
    onSuccess: async (data, { email }) => {
      if (data.success) {
        await navigate({ to: '/auth/magic-link', search: { email } });
      }
    },
  });

  return (
    <div className="flex w-full flex-col items-center justify-center gap-6">
      <h1 className="font-bold text-3xl">Email Login</h1>
      {!sendLinkMutation.isSuccess && (
        <form
          onSubmit={handleSubmit((data) => sendLinkMutation.mutate(data))}
          className="flex w-full max-w-sm flex-col gap-4 rounded-md p-4"
        >
          <div className="flex min-h-16 flex-col justify-between gap-1 text-center">
            <Input {...register('email')} placeholder="example@gmail.com" autoFocus className="text-center" />
            <p className="text-red-500 text-sm">{errors.email?.message}</p>
          </div>
          <Button type="submit" disabled={sendLinkMutation.isPending}>
            Send Code
          </Button>
        </form>
      )}
      {sendLinkMutation.isSuccess && sendLinkMutation.data.success && (
        <p className="text-purple-400 text-sm">Login code has been sent to your email</p>
      )}
    </div>
  );
}
