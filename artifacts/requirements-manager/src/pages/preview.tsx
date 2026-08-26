import { useState } from "react";
import {
  getGetProjectDocumentQueryKey,
  getGetSessionQueryKey,
  sendProjectDocument,
  useGetProjectDocument,
  useGetSession,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileText, Code2, Send, Download, Loader2, ArrowLeft, CheckCircle2 } from "lucide-react";
import { Link } from "wouter";

export default function Preview({ id }: { id: string }) {
  const numericId = parseInt(id, 10);
  const { data: session, isLoading: isSessionLoading } = useGetSession(numericId, {
    query: { queryKey: getGetSessionQueryKey(numericId) },
  });
  const { data: document, isLoading: isDocLoading } = useGetProjectDocument(numericId, {
    query: {
      queryKey: getGetProjectDocumentQueryKey(numericId),
        enabled: Boolean(session?.has_document)
    }
  });

  const isLoading = isSessionLoading || isDocLoading;

  const [isSent, setIsSent] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const downloadMarkdown = () => {
    if (!document) return;
    const blob = new Blob([document.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = window.document.createElement("a");
    link.href = url;
    link.download = `${document.title || "technical-brief"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const deliverDocument = async () => {
    setIsSending(true);
    setSendError(null);
    try {
      await sendProjectDocument({ session_id: numericId });
      setIsSent(true);
    } catch {
      setSendError("Не удалось отправить ТЗ. Проверьте настройки почты и повторите попытку.");
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
        <Loader2 className="w-12 h-12 animate-spin text-primary" />
        <h3 className="text-xl font-bold">Генерируем техническое задание</h3>
        <p className="text-muted-foreground">AI-менеджер структурирует требования и оформляет документ...</p>
      </div>
    );
  }

  if (!document) {
    return (
      <div className="container mx-auto p-8 text-center space-y-4">
        <p className="text-muted-foreground">Документ еще не готов.</p>
        <Link href={`/chat/${numericId}`}>
          <Button variant="outline"><ArrowLeft className="w-4 h-4 mr-2" /> Вернуться к диалогу</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 md:px-8 py-8 flex flex-col h-full max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
        <div>
          <Link href="/dashboard" className="text-sm font-medium text-muted-foreground hover:text-foreground flex items-center mb-4 transition-colors">
            <ArrowLeft className="w-4 h-4 mr-1" /> К списку проектов
          </Link>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-bold tracking-tight">{document.title}</h1>
            <Badge variant={document.status === "draft" ? "secondary" : "success"} className="h-6">
              {document.status === "draft" ? "Текущая черновая версия" : "Готово"}
            </Badge>
          </div>
          <p className="text-muted-foreground text-lg max-w-2xl">
            Ваши требования формализованы. Ознакомьтесь с результатом перед отправкой в разработку.
          </p>
        </div>
        
        <div className="flex flex-wrap gap-3">
          {session?.status === "active" && (
            <Button variant="outline" className="shadow-sm" asChild>
              <Link href={`/chat/${numericId}`}>
                <ArrowLeft className="w-4 h-4 mr-2" /> Вернуться к диалогу
              </Link>
            </Button>
          )}
          <Button variant="outline" className="shadow-sm" onClick={downloadMarkdown}>
            <Download className="w-4 h-4 mr-2" /> Скачать Markdown
          </Button>
          {document.status !== "draft" && (
          <Button
              className={`shadow-md font-semibold px-6 transition-all ${isSent ? 'bg-green-600 hover:bg-green-700 text-white' : ''}`}
              onClick={deliverDocument}
              disabled={isSent || isSending}
            >
              {isSent ? (
                <><CheckCircle2 className="w-4 h-4 mr-2" /> Отправлено</>
              ) : isSending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Отправляем</>
              ) : (
                <><Send className="w-4 h-4 mr-2" /> Отправить разработчикам</>
              )}
            </Button>
          )}
        </div>
        {sendError ? <p className="text-sm text-destructive">{sendError}</p> : null}
      </div>

      <Card className="flex-1 flex flex-col overflow-hidden border-2 shadow-sm rounded-xl">
        <Tabs defaultValue="markdown" className="flex-1 flex flex-col">
          <div className="border-b px-4 py-3 bg-muted/30">
            <TabsList className="bg-muted">
              <TabsTrigger value="markdown" className="data-[state=active]:bg-background">
                <FileText className="w-4 h-4 mr-2" /> Читаемый вид (Markdown)
              </TabsTrigger>
              <TabsTrigger value="json" className="data-[state=active]:bg-background">
                <Code2 className="w-4 h-4 mr-2" /> Структура (JSON)
              </TabsTrigger>
            </TabsList>
          </div>
          
          <TabsContent value="markdown" className="flex-1 p-0 m-0 mt-0 data-[state=active]:flex overflow-hidden">
            <ScrollArea className="flex-1 bg-white dark:bg-card">
              <div className="p-8 md:p-12 prose prose-stone dark:prose-invert prose-headings:font-bold prose-h1:text-3xl prose-h2:text-2xl prose-h2:mt-10 max-w-none">
                <div className="whitespace-pre-wrap font-medium text-foreground">{document.markdown}</div>
              </div>
            </ScrollArea>
          </TabsContent>
          
          <TabsContent value="json" className="flex-1 p-0 m-0 mt-0 data-[state=active]:flex overflow-hidden bg-[#1e1e1e]">
            <ScrollArea className="flex-1">
              <pre className="p-8 text-sm font-mono text-green-400">
                {JSON.stringify(document.json_data, null, 2)}
              </pre>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}
