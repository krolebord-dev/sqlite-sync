import { useMutation } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { initiateGoogleSignIn, signUpWithMagicLink } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_auth/sign-in")({
  component: RouteComponent,
});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function RouteComponent() {
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (sessionStorage.getItem("signedOut")) {
      sessionStorage.removeItem("signedOut");
      toast.success("You have been signed out.");
    }
  }, []);

  const { mutate: sendMagicLink, isPending } = useMutation({
    mutationFn: (data: { email: string }) => signUpWithMagicLink({ data }),
    onSuccess: () => {
      toast.success("Magic link sent! Check your email.");
      navigate({ to: "/magic-link-verify", search: { email, code: undefined } });
    },
    onError: () => {
      toast.error("Failed to send magic link. Please try again.");
    },
  });

  const handleSendMagicLink = () => {
    if (!email.trim()) {
      setEmailError("Please enter your email address.");
      return;
    }
    if (!isValidEmail(email)) {
      setEmailError("Please enter a valid email address.");
      return;
    }
    setEmailError(null);
    sendMagicLink({ email });
  };

  return (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle className="text-lg md:text-xl">Sign In</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Enter your email below to login to your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="m@example.com"
              required
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSendMagicLink();
                }
              }}
              value={email}
            />
            {emailError && <p className="text-destructive text-sm">{emailError}</p>}
            <Button disabled={isPending} className="gap-2" onClick={handleSendMagicLink}>
              {isPending ? <Loader2 size={16} className="animate-spin" /> : "Sign-in with Magic Link"}
            </Button>
          </div>

          <div className="flex w-full flex-col items-center justify-between gap-2">
            <Button
              variant="outline"
              className={cn("w-full gap-2")}
              disabled={isPending}
              onClick={async () => {
                try {
                  const result = await initiateGoogleSignIn();
                  window.location.href = result.url;
                } catch {
                  toast.error("Failed to initiate Google sign-in");
                }
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 256 262">
                <title>Google</title>
                <path
                  fill="#4285F4"
                  d="M255.878 133.451c0-10.734-.871-18.567-2.756-26.69H130.55v48.448h71.947c-1.45 12.04-9.283 30.172-26.69 42.356l-.244 1.622l38.755 30.023l2.685.268c24.659-22.774 38.875-56.282 38.875-96.027"
                />
                <path
                  fill="#34A853"
                  d="M130.55 261.1c35.248 0 64.839-11.605 86.453-31.622l-41.196-31.913c-11.024 7.688-25.82 13.055-45.257 13.055c-34.523 0-63.824-22.773-74.269-54.25l-1.531.13l-40.298 31.187l-.527 1.465C35.393 231.798 79.49 261.1 130.55 261.1"
                />
                <path
                  fill="#FBBC05"
                  d="M56.281 156.37c-2.756-8.123-4.351-16.827-4.351-25.82c0-8.994 1.595-17.697 4.206-25.82l-.073-1.73L15.26 71.312l-1.335.635C5.077 89.644 0 109.517 0 130.55s5.077 40.905 13.925 58.602z"
                />
                <path
                  fill="#EB4335"
                  d="M130.55 50.479c24.514 0 41.05 10.589 50.479 19.438l36.844-35.974C195.245 12.91 165.798 0 130.55 0C79.49 0 35.393 29.301 13.925 71.947l42.211 32.783c10.59-31.477 39.891-54.251 74.414-54.251"
                />
              </svg>
              Sign in with Google
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
