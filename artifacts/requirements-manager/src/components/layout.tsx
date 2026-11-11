import { ReactNode, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useLogout } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, LogOut, UserCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import { EMAIL_AUTH_UI_ENABLED, resetEmailCsrfToken } from "@/lib/email-auth";

export function Layout({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const logout = useLogout();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation("/login");
    }
  }, [isAuthenticated, isLoading, setLocation]);

  const handleLogout = async () => {
    if (EMAIL_AUTH_UI_ENABLED) {
      try {
        await logout.mutateAsync();
      } catch {
        toast({
          variant: "destructive",
          title: "Не удалось выйти",
          description: "Вы всё ещё в аккаунте. Проверьте соединение и попробуйте ещё раз.",
        });
        return;
      }
      await queryClient.cancelQueries();
      resetEmailCsrfToken();
      queryClient.clear();
      setLocation("/login");
      return;
    }
    try {
      await logout.mutateAsync();
    } finally {
      queryClient.clear();
      setLocation("/login");
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-10 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="container mx-auto px-4 md:px-8 h-16 flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2 group">
            <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold shadow-sm transition-transform group-hover:scale-105">
              T
            </div>
            <span className="font-bold text-lg tracking-tight">ТехЗадание.AI</span>
          </Link>

          <div className="flex items-center gap-6">
            <nav className="hidden md:flex items-center gap-1 text-sm font-medium">
              <Link href="/dashboard" className="px-3 py-2 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
                {EMAIL_AUTH_UI_ENABLED ? "Мои ТЗ" : "Дашборд"}
              </Link>
            </nav>
            <div className="flex items-center gap-4 border-l border-border pl-6">
              <div className="flex items-center gap-2 text-sm">
                <UserCircle className="w-5 h-5 text-muted-foreground" />
                <span className="font-medium text-foreground">{user?.name}</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleLogout}
                disabled={logout.isPending}
                title="Выйти"
                className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              >
                {logout.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1 flex flex-col">
        {children}
      </main>
    </div>
  );
}
