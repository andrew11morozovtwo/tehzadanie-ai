import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { useListSessions, useCreateSession, getListSessionsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PlusCircle, MessageSquare, Clock, FileText, ChevronRight, Loader2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";
import { EMAIL_AUTH_UI_ENABLED } from "@/lib/email-auth";

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth();
  
  useEffect(() => {
    if (!isAuthLoading && !isAuthenticated) {
      setLocation("/login");
    }
  }, [isAuthenticated, isAuthLoading, setLocation]);

  const { data: sessions, isLoading: isSessionsLoading } = useListSessions({
    query: {
      queryKey: getListSessionsQueryKey(),
      enabled: isAuthenticated
    }
  });

  const createSession = useCreateSession();

  const handleNewProject = () => {
    createSession.mutate({ data: {} }, {
      onSuccess: (session) => {
        setLocation(`/chat/${session.id}`);
      }
    });
  };

  const statusMap: Record<string, { label: string, variant: "default" | "secondary" | "success" }> = {
    active: { label: "В работе", variant: "default" },
    draft: { label: "Черновик ТЗ", variant: "secondary" },
    final: { label: "ТЗ готово", variant: "success" },
    sent: { label: "Отправлено", variant: "success" },
  };

  if (isAuthLoading || !isAuthenticated) return null;

  return (
    <div className="container mx-auto px-4 md:px-8 py-8 md:py-12 max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-10">
        <div className="space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">{EMAIL_AUTH_UI_ENABLED ? "Мои ТЗ" : "Ваши проекты"}</h1>
          <p className="text-muted-foreground text-lg">Обсуждения и готовые технические задания.</p>
        </div>
        <Button size="lg" onClick={handleNewProject} disabled={createSession.isPending} className="shadow-md">
          {createSession.isPending ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <PlusCircle className="w-5 h-5 mr-2" />}
          Новый проект
        </Button>
      </div>

      {isSessionsLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse h-48 bg-muted/20" />
          ))}
        </div>
      ) : sessions?.length === 0 ? (
        <Card className="border-dashed bg-transparent p-12 text-center flex flex-col items-center justify-center space-y-4 mt-8">
          <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center">
            <MessageSquare className="w-8 h-8" />
          </div>
          <CardTitle className="text-2xl">У вас пока нет проектов</CardTitle>
          <CardDescription className="max-w-md text-base">
            Нажмите «Новый проект», чтобы начать диалог с AI-менеджером и сформировать требования для вашей идеи.
          </CardDescription>
          <Button onClick={handleNewProject} disabled={createSession.isPending} className="mt-4">
            Начать первый проект
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sessions?.map((session) => {
            const status = statusMap[session.status] || { label: session.status, variant: "secondary" };
            return (
              <Card key={session.id} className="group hover:border-primary/50 transition-colors flex flex-col cursor-pointer overflow-hidden" onClick={() => setLocation(session.status === 'active' ? `/chat/${session.id}` : `/preview/${session.id}`)}>
                <CardHeader className="pb-4">
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <Badge variant={status.variant} className="shrink-0">{status.label}</Badge>
                    <div className="flex items-center text-xs text-muted-foreground whitespace-nowrap">
                      <Clock className="w-3 h-3 mr-1" />
                      {format(parseISO(session.last_active), "d MMM, HH:mm", { locale: ru })}
                    </div>
                  </div>
                  <CardTitle className="line-clamp-2 text-xl group-hover:text-primary transition-colors">
                    {session.title}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex-1">
                  <p className="text-sm text-muted-foreground line-clamp-3">
                    {session.summary || "Диалог только начался, идея формируется..."}
                  </p>
                </CardContent>
                <div className="px-6 py-4 bg-muted/20 border-t flex flex-wrap items-center justify-between gap-3 mt-auto">
                  <div className="flex items-center text-sm font-medium text-muted-foreground">
                    <MessageSquare className="w-4 h-4 mr-2" />
                    {session.message_count} сообщений
                  </div>
                  <div className="flex items-center gap-2 ml-auto">
                    {session.status === 'final' || session.status === 'sent' ? (
                      <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className="bg-background"
                      >
                        <Link
                          href={`/chat/${session.id}`}
                          onClick={(event) => {
                          event.stopPropagation();
                          }}
                        >
                          <MessageSquare className="w-4 h-4 mr-1.5" />
                           Продолжить редактирование
                        </Link>
                      </Button>
                    ) : null}
                    <div className="text-primary opacity-0 group-hover:opacity-100 transform translate-x-2 group-hover:translate-x-0 transition-all flex items-center text-sm font-semibold">
                      {session.status === 'active' ? 'Продолжить диалог' : 'Смотреть ТЗ'}
                      <ChevronRight className="w-4 h-4 ml-1" />
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
