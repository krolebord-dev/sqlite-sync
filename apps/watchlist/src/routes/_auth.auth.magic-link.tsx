import { zodResolver } from '@hookform/resolvers/zod';
import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/trpc';

const magicLinkSchema = z.object({
  email: z.string().email().optional(),
  token: z
    .string()
    .or(z.number().transform((val) => val.toString()))
    .optional(),
});

export const Route = createFileRoute('/_auth/auth/magic-link')({
  component: RouteComponent,
  validateSearch: zodValidator(magicLinkSchema),
  loaderDeps: ({ search }) => ({ email: search.email, token: search.token }),
  loader: async ({ deps, context: { trpcClient } }) => {
    if (!deps.email) {
      throw redirect({ to: '/login', replace: true });
    }

    if (!deps.token) {
      return { status: 'missing-token' as const };
    }

    const result = await trpcClient.auth.useMagicLink.mutate({ email: deps.email, token: deps.token });

    if (result.status === 'success') {
      if (result.listId) {
        throw redirect({ to: '/list/$id', params: { id: result.listId }, replace: true });
      }
      throw redirect({ to: '/', replace: true });
    }

    return result;
  },
});

function RouteComponent() {
  const { status } = Route.useLoaderData();
  return (
    <div className="flex w-full flex-col items-center justify-center gap-6">
      {status === 'invalid-token' && (
        <>
          <h1 className="font-bold text-3xl">Email Login</h1>
          <p className="text-red-500 text-sm">Seems like your login code has expired</p>
          <Button asChild>
            <Link to="/login">Send me a new code again</Link>
          </Button>
        </>
      )}
      {status === 'user-not-found' ? <Onboarding /> : <CodeLogin />}
    </div>
  );
}

const codeLoginSchema = z.object({
  token: z.string(),
});

type CodeLoginFormSchema = z.infer<typeof codeLoginSchema>;

function CodeLogin() {
  const { email } = Route.useLoaderDeps();
  const navigate = useNavigate();

  const loginMutation = trpc.auth.useMagicLink.useMutation({
    onSuccess: (data) => {
      if (data.status === 'success') {
        if (data.listId) {
          navigate({ to: '/list/$id', params: { id: data.listId }, replace: true });
          return;
        }

        navigate({ to: '/', replace: true });
      }
    },
  });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CodeLoginFormSchema>({
    resolver: zodResolver(codeLoginSchema),
  });

  const onSubmit = (data: CodeLoginFormSchema) => {
    if (!email) {
      return;
    }

    loginMutation.mutate({ email, token: data.token });
  };

  return (
    <>
      <h1 className="font-bold text-3xl">Email Login</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="flex w-full max-w-sm flex-col gap-4 rounded-md p-4">
        <div className="flex min-h-16 flex-col justify-between gap-1 text-center">
          <Input {...register('token')} placeholder="Your code" autoFocus className="text-center" />
          <p className="text-red-500 text-sm">{errors.token?.message ?? loginMutation.data?.status}</p>
        </div>
        <Button type="submit" disabled={loginMutation.isPending}>
          Submit
        </Button>
        <Button asChild variant="outline">
          <Link to="/login">Send me a new code again</Link>
        </Button>
      </form>
    </>
  );
}

const registerSchema = z.object({
  name: z.string().min(2),
});

type RegisterFormSchema = z.infer<typeof registerSchema>;

function Onboarding() {
  const { email, token } = Route.useLoaderDeps();
  const navigate = useNavigate();

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: (data) => {
      if (data.status === 'success') {
        if (data.listId) {
          navigate({ to: '/list/$id', params: { id: data.listId }, replace: true });
          return;
        }

        navigate({ to: '/', replace: true });
      }
    },
  });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormSchema>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = (data: RegisterFormSchema) => {
    if (!email || !token) {
      return;
    }

    registerMutation.mutate({ email, token, name: data.name });
  };

  return (
    <>
      <h1 className="font-bold text-3xl">Welcome!</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="flex w-full max-w-sm flex-col gap-4 rounded-md p-4">
        <div className="flex min-h-16 flex-col justify-between gap-1 text-center">
          <Input {...register('name')} placeholder="Your name" autoFocus className="text-center" />
          <p className="text-red-500 text-sm">{errors.name?.message}</p>
        </div>
        <Button type="submit" disabled={registerMutation.isPending}>
          Submit
        </Button>
      </form>
    </>
  );
}
