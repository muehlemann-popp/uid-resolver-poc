export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const from = sp.from && sp.from.startsWith("/") ? sp.from : "/";

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        method="POST"
        action="/api/login"
        autoComplete="off"
        className="w-full max-w-sm rounded-lg border border-neutral-200 bg-white p-8"
      >
        <h1 className="text-2xl font-extrabold tracking-tight text-neutral-800">
          UID Resolver
        </h1>
        <p className="mt-1 mb-6 text-sm text-neutral-500">
          Proof of concept - password protected.
        </p>

        <label
          htmlFor="password"
          className="mb-2 block text-sm font-semibold text-neutral-700"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoFocus
          className="w-full rounded border border-neutral-300 p-2 outline-none focus:border-[var(--color-mustard)]"
        />
        <input type="hidden" name="from" value={from} />

        {sp.error === "1" && (
          <p className="mt-3 text-sm font-semibold text-red-700">
            Wrong password.
          </p>
        )}

        <button
          type="submit"
          className="mt-6 w-full rounded bg-[var(--color-mustard)] px-5 py-2 text-sm font-bold text-neutral-900 transition hover:brightness-95"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
