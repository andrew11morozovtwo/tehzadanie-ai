import { ReactNode, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowRight, CheckCircle2, MailCheck, ShieldCheck } from "lucide-react";
import { postEmailAuth } from "@/lib/email-auth";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      <div className="flex-1 bg-muted/70 text-foreground p-8 md:p-16 flex flex-col justify-between relative overflow-hidden border-b md:border-b-0 md:border-r border-border">
        <div className="absolute top-[-20%] left-[-10%] w-[150%] h-[150%] bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent pointer-events-none opacity-70" />
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-12 md:mb-16">
            <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-xl shadow-sm">T</div>
            <span className="font-bold text-2xl tracking-tight">ТехЗадание.AI</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold leading-[1.1] mb-6 tracking-tight">
            Ваши ТЗ остаются <br />
            <span className="text-primary">только вашими</span>.
          </h1>
          <p className="text-lg text-muted-foreground max-w-lg leading-relaxed">
            Вход по ссылке из письма. Без паролей, которые можно забыть или перехватить. Все прежние документы сохраняются в вашем аккаунте.
          </p>
        </div>
        <div className="relative z-10 space-y-4 hidden md:block">
          {["Ссылка одноразовая и действует 15 минут", "Нажмите ссылку в письме — и сразу в «Мои ТЗ»", "Старые проекты и файлы никуда не исчезают"].map((f) => (
            <div key={f} className="flex items-center gap-3 text-foreground/80 font-medium">
              <CheckCircle2 className="w-5 h-5 text-primary" />
              {f}
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
          <div className="text-center md:text-left space-y-2">
            <h2 className="text-3xl font-bold tracking-tight">{title}</h2>
            <p className="text-muted-foreground">{subtitle}</p>
          </div>
          <Card className="border-none shadow-xl shadow-black/5">
            <CardContent className="p-6">{children}</CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

type RequestResult = { status?: string; message?: string; error?: string; retry_after_seconds?: number };

const UNIFORM = "Если адрес можно использовать для входа, письмо со ссылкой уже в пути. Проверьте почту и папку «Спам».";

export default function EmailLogin() {
  const [, setLocation] = useLocation();
  const { isAuthenticated } = useAuth();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (isAuthenticated) setLocation("/dashboard");
  }, [isAuthenticated, setLocation]);

  useEffect(() => {
    if (cooldown <= 0) return;
    timer.current = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [cooldown]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cooldown > 0 || pending) return;
    setError("");
    setPending(true);
    try {
      const { data } = await postEmailAuth<RequestResult>("request", { email: email.trim() });
      if (data.status === "accepted") {
        setSent(data.message || UNIFORM);
        setCooldown(60);
      } else if (data.status === "limited") {
        setCooldown(Math.max(1, Math.ceil(data.retry_after_seconds ?? 60)));
        setError(data.error || "Слишком много запросов. Подождите немного.");
      } else {
        setError(data.error || "Не удалось отправить ссылку. Попробуйте ещё раз.");
      }
    } catch {
      setError("Нет связи с сервером. Попробуйте ещё раз.");
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell title="Вход по email" subtitle="Мы пришлём ссылку для входа. Пароль не нужен.">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email-login">Email</Label>
          <Input id="email-login" type="email" required autoComplete="email" placeholder="client@example.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={pending} />
        </div>
        {sent ? (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm flex gap-3" role="status">
            <MailCheck className="w-5 h-5 text-primary shrink-0 mt-0.5" />
            <p className="text-foreground">{sent}</p>
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive font-medium" role="alert">{error}</p> : null}
        <Button type="submit" size="lg" className="w-full" disabled={pending || cooldown > 0}>
          {pending ? "Отправляем..." : cooldown > 0 ? `Повторно через ${cooldown} с` : sent ? "Отправить ещё раз" : "Получить ссылку"}
          {!pending && cooldown <= 0 ? <ArrowRight className="w-4 h-4 ml-2" /> : null}
        </Button>
        <p className="text-xs text-muted-foreground flex gap-2">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          Нажмите ссылку в письме — раздел «Мои ТЗ» откроется автоматически. Пароль не нужен.
        </p>
      </form>
    </AuthShell>
  );
}
