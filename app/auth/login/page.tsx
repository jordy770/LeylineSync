import { LoginForm } from "@/components/login-form";

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

export default async function Page({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const redirectTo = getSafeRedirect(params?.next);

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm redirectTo={redirectTo} />
      </div>
    </div>
  );
}
