import { NextResponse } from "next/server";

const PASSWORD = process.env.SITE_PASSWORD;
const COOKIE = "mp_auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const password = String(form.get("password") ?? "");
  const fromRaw = String(form.get("from") ?? "/");
  const from =
    fromRaw.startsWith("/") && !fromRaw.startsWith("//") ? fromRaw : "/";

  if (!PASSWORD || password !== PASSWORD) {
    const url = new URL("/login", req.url);
    if (from !== "/") url.searchParams.set("from", from);
    url.searchParams.set("error", "1");
    return NextResponse.redirect(url, { status: 303 });
  }

  const res = NextResponse.redirect(new URL(from, req.url), { status: 303 });
  res.cookies.set({
    name: COOKIE,
    value: PASSWORD,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
