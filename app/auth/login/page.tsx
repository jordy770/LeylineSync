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
  // `dark` flips the Shadcn tokens so the card matches the game's dark
  // chrome instead of rendering as an unthemed white island (designqc).
  return (
    <div className="dark flex min-h-svh w-full flex-col items-center justify-center gap-6 bg-slate-950 p-6 md:p-10">
      <p className="text-xl font-black tracking-tight text-white">
        Leyline <span className="text-emerald-400">Sync</span>
      </p>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
