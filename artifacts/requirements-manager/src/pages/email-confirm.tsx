import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowRight, Loader2 } from "lucide-react";
import { AuthShell } from "@/pages/email-login";
import { postEmailAuth, resetEmailCsrfToken } from "@/lib/email-auth";

// Memory only; survives StrictMode's effect replay, never stored in the browser.
let capturedToken: string | null = null;
let clearTimer: number | null = null;
function captureTokenFromHash(): string | null {
  if (window.location.hash.includes("token=")) {
    capturedToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return capturedToken;
}

type Confirm = { status?: string; error?: string; user?: { id: number; name: string; email: string } };
type Phase = "loading" | "dead" | "consent" | "retry";
const DEAD: Record<string, string> = {
  expired: "Срок действия ссылки истёк.",
  used: "Эта ссылка уже использована.",
  invalid: "Ссылка недействительна или повреждена.",
  forbidden: "Не удалось подтвердить безопасность запроса. Повторите вход.",
  unavailable: "Вход по ссылке временно недоступен.",
};

export default function EmailConfirm() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const tokenRef = useRef<string | null>(null);
  if (tokenRef.current === null) tokenRef.current = captureTokenFromHash();
  const initialRequest = useRef<ReturnType<typeof postEmailAuth<Confirm>> | null>(null);
  const inFlight = useRef(false);
  const [phase, setPhase] = useState<Phase>(tokenRef.current ? "loading" : "dead");
  const [error, setError] = useState(tokenRef.current ? "" : DEAD.invalid);
  const [pending, setPending] = useState(false);

  const discardSecrets = useCallback(() => {
    tokenRef.current = null;
    capturedToken = null;
  }, []);

  const applyResult = useCallback(async (data: Confirm) => {
    if (data.status === "confirmed" && data.user) {
      discardSecrets();
      resetEmailCsrfToken();
      await queryClient.cancelQueries();
      queryClient.clear();
      queryClient.setQueryData(getGetMeQueryKey(), data.user);
      // The email link always lands on the user's own "Мои ТЗ".
      setLocation("/dashboard", { replace: true });
    } else if (data.status === "consent_required") {
      setError("");
      setPhase("consent");
    } else if (data.status === "unavailable" || data.status === "forbidden") {
      setError(data.error || DEAD[data.status]);
      setPhase("retry");
    } else {
      discardSecrets();
      setError(data.error || DEAD[data.status ?? "invalid"] || DEAD.invalid);
      setPhase("dead");
    }
  }, [discardSecrets, queryClient, setLocation]);

  useEffect(() => {
    if (clearTimer) window.clearTimeout(clearTimer);
    clearTimer = null;
    return () => {
      clearTimer = window.setTimeout(() => { capturedToken = null; }, 0);
    };
  }, []);

  useEffect(() => {
    const token = tokenRef.current;
    if (!token) return;
    let alive = true;
    // Exactly one POST even when React replays effects in development.
    // GET itself remains read-only; CSRF and atomic consumption stay server-side.
    initialRequest.current ??= postEmailAuth<Confirm>("confirm", { token, switch_consent: false });
    initialRequest.current.then(async ({ data }) => {
      if (alive) await applyResult(data);
    }).catch(() => {
      if (!alive) return;
      setError("Нет связи с сервером. Повторите вход по этой ссылке.");
      setPhase("retry");
    });
    return () => { alive = false; };
  }, [applyResult]);

  const confirm = async (switchConsent: boolean) => {
    if (!tokenRef.current || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const { data } = await postEmailAuth<Confirm>("confirm", {
        token: tokenRef.current, switch_consent: switchConsent,
      });
      await applyResult(data);
    } catch {
      setError("Нет связи с сервером. Повторите вход по этой ссылке.");
      if (!switchConsent) setPhase("retry");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  if (phase === "loading") {
    return (
      <AuthShell title="Открываем Мои ТЗ" subtitle="Входим по ссылке из письма. Ничего нажимать не нужно.">
        <div role="status" aria-busy="true" className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span>Выполняем вход…</span>
        </div>
      </AuthShell>
    );
  }

  if (phase === "consent") {
    return (
      <AuthShell title="Сменить аккаунт?" subtitle="В этом браузере уже открыт другой аккаунт.">
        <div className="space-y-4">
          <p className="text-sm">Ссылка относится к другому аккаунту. При переключении документы обоих аккаунтов сохранятся.</p>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <Button className="w-full" size="lg" disabled={pending} onClick={() => void confirm(true)}>
            Да, переключиться
          </Button>
          <Button className="w-full" size="lg" variant="outline" disabled={pending} onClick={() => {
            discardSecrets();
            setLocation("/dashboard", { replace: true });
          }}>Остаться в текущем аккаунте</Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Не удалось войти" subtitle="Ваши документы сохранены.">
      <div className="space-y-4">
        <div role="alert" className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" /><p>{error}</p>
        </div>
        {phase === "retry" ? (
          <Button className="w-full" size="lg" disabled={pending} onClick={() => void confirm(false)}>
            Повторить вход
          </Button>
        ) : null}
        <Button className="w-full" size="lg" variant={phase === "retry" ? "outline" : "default"} disabled={pending} onClick={() => {
          discardSecrets();
          setLocation("/login", { replace: true });
        }}>Запросить новую ссылку <ArrowRight className="h-4 w-4 ml-2" /></Button>
      </div>
    </AuthShell>
  );
}
