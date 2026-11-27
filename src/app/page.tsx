"use client";

import { useCallback, useEffect, useState } from "react";
import { apiPost } from "@/lib/client";
import { AuthScreen } from "@/components/tv/auth-screen";
import { AppShell } from "@/components/tv/shell";
import { Loader2, Radio } from "lucide-react";
import type { Me } from "@/components/tv/types";

export default function Page() {
  const [state, setState] = useState<"loading" | "guest" | "authed">("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data: { user: Me | null; needsSetup: boolean }) => {
        if (cancelled) return;
        if (data.user) {
          setMe(data.user);
          setState("authed");
        } else {
          setNeedsSetup(data.needsSetup);
          setState("guest");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setNeedsSetup(true);
        setState("guest");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const logout = useCallback(async () => {
    await apiPost("/api/auth/logout").catch(() => undefined);
    setMe(null);
    setState("loading");
    setReloadKey((k) => k + 1);
  }, []);

  if (state === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950 text-zinc-300">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-600 tv-glow">
          <Radio className="h-7 w-7 text-white" />
        </div>
        <p className="text-sm font-semibold tracking-wide">24/7 INTERNET TV</p>
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
      </div>
    );
  }

  if (state === "guest") {
    return (
      <AuthScreen
        needsSetup={needsSetup}
        onAuthed={(user) => {
          setMe(user);
          setState("authed");
        }}
      />
    );
  }

  return <AppShell user={me!} onLogout={logout} />;
}
