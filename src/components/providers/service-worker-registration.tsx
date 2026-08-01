"use client";

import { useEffect } from "react";

const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHostname(hostname: string) {
  return (
    localHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname === "lvh.me" ||
    hostname.endsWith(".lvh.me")
  );
}

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    // Service workers and Turbopack's mutable development chunks must never
    // share a cache. The root layout also removes legacy registrations before
    // hydration so a stale worker cannot prevent this component from loading.
    if (process.env.NODE_ENV !== "production") return;

    const canRegister =
      window.location.protocol === "https:" ||
      isLocalHostname(window.location.hostname);

    if (!canRegister) return;

    let cancelled = false;

    const register = async () => {
      if (cancelled) return;

      await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      }).catch(() => {
        // Service workers can be unavailable in some embedded previews.
      });
    };

    if (document.readyState === "complete") {
      void register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
