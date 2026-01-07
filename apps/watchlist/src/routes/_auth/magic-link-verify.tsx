import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import z from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifyMagicLink } from "@/lib/auth";

export const Route = createFileRoute("/_auth/magic-link-verify")({
  component: RouteComponent,
  validateSearch: z.object({
    email: z.email().catch(""),
    code: z.coerce.string().length(6).optional(),
  }),
  beforeLoad: async ({ search }) => {
    if (!search.email) {
      throw redirect({ to: "/sign-in" });
    }
  },
});

function RouteComponent() {
  const { email, code: initialCode } = Route.useSearch();
  const [code, setCode] = useState(initialCode ?? "");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const { mutate: verify, isPending } = useMutation({
    mutationFn: (data: { email: string; code: string }) => verifyMagicLink({ data }),
    onSuccess: (result) => {
      if (result.success) {
        toast.success("Successfully signed in!");
        navigate({ to: "/" });
      } else {
        setError(result.error ?? "Verification failed");
      }
    },
    onError: () => {
      toast.error("An unexpected error occurred");
    },
  });

  const handleSubmit = () => {
    if (!email) {
      setError("Email is required");
      return;
    }
    if (code.length !== 6) {
      setError("Code must be 6 digits");
      return;
    }
    setError(null);
    verify({ email, code });
  };

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="text-lg md:text-xl">Verify Magic Link</CardTitle>
        <CardDescription className="text-xs md:text-sm">Enter the verification code sent to your email</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={email ?? ""} readOnly disabled className="bg-muted" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="code">Verification Code</Label>
            <Input
              id="code"
              type="text"
              placeholder="123456"
              required
              maxLength={6}
              onChange={(e) => {
                const value = e.target.value.replace(/\D/g, "");
                setCode(value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSubmit();
                }
              }}
              value={code}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <Button disabled={isPending || code.length !== 6 || !email} className="gap-2" onClick={handleSubmit}>
            {isPending ? <Loader2 size={16} className="animate-spin" /> : "Verify Code"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
