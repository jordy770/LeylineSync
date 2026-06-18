import AuthShell from "@/components/AuthShell";
import { LoginForm } from "@/components/login-form";
import { Suspense } from "react";
import type { ReactNode } from "react";

type LoginPageProps = {
  searchParams?: Promise<{
    next?: string | string[];
  }>;
};

function getSafeRedirect(value: string | string[] | undefined) {
  const redirectTo = Array.isArray(value) ? value[0] : value;

  if (!redirectTo?.startsWith("/") || redirectTo.startsWith("//")) {
    return "/";
  }

  return redirectTo;
}

export default function Page({ searchParams }: LoginPageProps) {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginContent searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginContent({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const redirectTo = getSafeRedirect(params?.next);

  return (
    <LoginShell>
      <LoginForm redirectTo={redirectTo} />
    </LoginShell>
  );
}

function LoginShell({ children }: { children?: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
