import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import {
  getGetProjectDocumentQueryKey,
  getGetSessionQueryKey,
  useFinalizeSession,
  useGetSession,
  useSendMessage,
  type FinalizeBlocked,
  type ProjectDocument,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CheckCircle,
  ExternalLink,
  FileText,
  Loader2,
  Mic,
  Paperclip,
  RefreshCw,
  Send,
  X,
  User as UserIcon,
  Bot as BotIcon,
  ListTodo,
  AlertCircle,
  ArrowRight,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { ru } from "date-fns/locale";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function Chat({ id }: { id: string }) {
  const numericId = parseInt(id, 10);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  
  const { data: session, isLoading: isSessionLoading } = useGetSession(numericId);
  const sendMessage = useSendMessage();
  const finalizeSession = useFinalizeSession();
  
  const [content, setContent] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [attachments, setAttachments] = useState<Array<{ id: number; name: string; size: number }>>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [attachmentError, setAttachmentError] = useState("");
  const [chatError, setChatError] = useState("");
  const [brief, setBrief] = useState<ProjectDocument | null>(null);
  const [isBriefOpen, setIsBriefOpen] = useState(false);
  const [briefDialogState, setBriefDialogState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [isShowingMissing, setIsShowingMissing] = useState(false);

  const isSessionActive = session?.status === "active";
  const quickActions = session?.interview_state?.available_actions?.filter(a => a !== 'save_draft' && a !== 'finalize') || [];
  const isReadyToFinalize = session?.interview_state?.ready_to_finalize ?? false;
  const canFinalizeNow =
    isReadyToFinalize &&
    Boolean(session?.interview_state?.available_actions?.includes("finalize"));

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [session?.messages, sendMessage.isPending]);

  useEffect(() => {
    if (!session) return;
    fetch(`/api/sessions/${numericId}/files`)
      .then((response) => response.ok ? response.json() : [])
      .then((files) => setAttachments(files))
      .catch(() => setAttachmentError("Не удалось загрузить список материалов."));
  }, [numericId, session]);

  useEffect(() => {
    if (
      session &&
      !isSessionActive &&
      session.interview_state?.available_actions?.includes("continue_editing")
    ) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [session, isSessionActive]);

  const handleSend = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!content.trim() || sendMessage.isPending) return;
    setChatError("");
    sendMessage.mutate(
      { id: numericId, data: { content: content.trim() } },
      {
        onSuccess: () => {
          setContent("");
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(numericId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectDocumentQueryKey(numericId) });
        },
        onError: () => {
          setChatError("Не удалось обработать сообщение. Попробуйте ещё раз.");
        }
      }
    );
  };

  const handleSendQuickCommand = (text: string, onSuccess?: () => void) => {
    if (sendMessage.isPending) return;
    setChatError("");
    sendMessage.mutate(
      { id: numericId, data: { content: text } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(numericId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectDocumentQueryKey(numericId) });
          onSuccess?.();
        },
        onError: () => {
          setChatError("Не удалось отправить сообщение.");
        }
      }
    );
  };

  const handleSaveDraft = () => {
    handleSendQuickCommand("Сохранить и продолжить позднее", () => {
      setLocation("/dashboard");
    });
  };

  const isFinalizeBlocked = (value: unknown): value is FinalizeBlocked => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<FinalizeBlocked>;
    return candidate.code === "MISSING_REQUIREMENTS" && Boolean(candidate.interview_state);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFinalize = () => {
    setChatError("");
    setBrief(null);
    setBriefDialogState("loading");
    setIsBriefOpen(true);
    finalizeSession.mutate(
      { id: numericId },
      {
        onSuccess: (document) => {
          queryClient.setQueryData(getGetProjectDocumentQueryKey(numericId), document);
          setBrief(document);
          setBriefDialogState("ready");
          setIsBriefOpen(true);
          queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(numericId) });
        },
        onError: (error) => {
          const payload =
            error && typeof error === "object" && "data" in error
              ? (error as { data?: unknown }).data
              : null;
          if (isFinalizeBlocked(payload)) {
            queryClient.setQueryData(getGetSessionQueryKey(numericId), (old: any) => {
              if (!old) return old;
              return { ...old, interview_state: payload.interview_state };
            });
            setIsBriefOpen(false);
            setChatError("Недостаточно данных для формирования ТЗ. Ответьте на оставшиеся вопросы.");
            setIsShowingMissing(true);
          } else {
            setBriefDialogState("error");
            const message =
              payload &&
              typeof payload === "object" &&
              "error" in payload &&
              typeof payload.error === "string"
                ? payload.error
                : "Не удалось сформировать ТЗ. Попробуйте ещё раз через минуту.";
            setChatError(message);
          }
        }
      }
    );
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
  };

  const startRecording = async () => {
    setVoiceError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setIsRecording(false);
        const audio = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (!audio.size) return;
        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append("audio", audio, "voice-message.webm");
          const response = await fetch("/api/transcribe", { method: "POST", body: formData });
          if (!response.ok) throw new Error("transcription failed");
          const data = (await response.json()) as { text?: string };
          if (data.text) setContent((current) => `${current}${current ? " " : ""}${data.text}`);
        } catch {
          setVoiceError("Не удалось распознать голос. Попробуйте записать еще раз.");
        } finally {
          setIsTranscribing(false);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      setVoiceError("Разрешите доступ к микрофону, чтобы записать голосовое сообщение.");
    }
  };

  const uploadReference = async (file?: File) => {
    if (!file) return;
    setAttachmentError("");
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch(`/api/sessions/${numericId}/files`, {
        method: "POST",
        body: formData,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? "Не удалось загрузить файл");
      }
      const saved = await response.json();
      setAttachments((current) => [saved, ...current]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "Не удалось загрузить файл.");
    } finally {
      setIsUploading(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  };

  const deleteReference = async (fileId: number) => {
    try {
      const response = await fetch(`/api/sessions/${numericId}/files/${fileId}`, { method: "DELETE" });
      if (!response.ok) throw new Error();
      setAttachments((current) => current.filter((file) => file.id !== fileId));
    } catch {
      setAttachmentError("Не удалось удалить файл.");
    }
  };

  if (isSessionLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full relative h-full">
      <Dialog open={isBriefOpen} onOpenChange={setIsBriefOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] gap-0 overflow-hidden p-0 border-border shadow-lg">
          {briefDialogState === "loading" ? (
            <>
              <DialogHeader className="px-5 py-6 pr-12 text-left">
                <DialogTitle className="flex items-center gap-2 text-xl font-bold">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  Формируем ТЗ
                </DialogTitle>
                <DialogDescription className="text-muted-foreground font-medium mt-1">
                  AI-менеджер структурирует требования. Обычно это занимает до минуты.
                </DialogDescription>
              </DialogHeader>
              <div className="flex min-h-[160px] items-center justify-center border-y bg-muted/30 px-5 text-center text-sm font-medium text-muted-foreground">
                Не закрывайте страницу — готовый документ появится здесь автоматически.
              </div>
            </>
          ) : briefDialogState === "error" ? (
            <>
              <DialogHeader className="px-5 py-6 pr-12 text-left">
                <DialogTitle className="text-xl font-bold">Не удалось сформировать ТЗ</DialogTitle>
                <DialogDescription className="text-muted-foreground font-medium mt-1">
                  AI не вернул готовый структурированный документ. Ваш диалог сохранён, можно безопасно повторить попытку.
                </DialogDescription>
              </DialogHeader>
              <div className="border-y bg-destructive/10 px-5 py-5 text-sm font-medium text-foreground">
                Документ ещё не создан, проект не закрыт. Нажмите «Повторить», чтобы снова запустить сборку ТЗ.
              </div>
              <DialogFooter className="border-t bg-muted/30 px-5 py-4 sm:px-6">
                <Button variant="outline" onClick={() => setIsBriefOpen(false)} className="font-medium">
                  Вернуться к диалогу
                </Button>
                <Button onClick={handleFinalize} disabled={finalizeSession.isPending} className="font-medium">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Повторить
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader className="border-b px-5 py-5 pr-12 text-left">
                <DialogTitle className="flex items-center gap-2 text-xl font-bold">
                  <CheckCircle className="h-5 w-5 text-primary" />
                  ТЗ готово
                </DialogTitle>
                <DialogDescription className="text-muted-foreground font-medium mt-1">
                  {brief?.title ?? "Техническое задание"} сформировано по вашему диалогу.
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[58vh]">
                <div className="whitespace-pre-wrap px-5 py-6 text-sm leading-relaxed text-foreground sm:px-8 font-medium">
                  {brief?.markdown}
                </div>
              </ScrollArea>
              <DialogFooter className="border-t bg-muted/30 px-5 py-4 sm:px-6">
                <Button variant="outline" onClick={() => setIsBriefOpen(false)} className="font-medium">
                  Закрыть
                </Button>
                <Button
                  className="font-medium"
                  onClick={() => {
                    setIsBriefOpen(false);
                    setLocation(`/preview/${numericId}`);
                  }}
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Открыть полный документ
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Header Area */}
      <div className="bg-background/95 backdrop-blur-md px-5 py-4 border-b flex flex-col sm:flex-row sm:items-center justify-between sticky top-0 z-10 gap-4 shadow-[0_1px_8px_rgba(0,0,0,0.02)] transition-all">
        <div className="flex flex-col gap-1 min-w-0">
          <h2 className="font-bold text-lg leading-tight tracking-tight text-foreground truncate">{session.title}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
            <span className="uppercase tracking-wider text-muted-foreground">
              {session.status === 'active' ? 'В процессе' : session.status === 'draft' ? 'Черновик' : 'Завершено'}
            </span>
            {session.interview_state?.progress && (
              <>
                <span className="text-muted-foreground/30">•</span>
                <span className="text-primary tracking-wide">
                  ГОТОВНОСТЬ {session.interview_state.progress.percent}%
                </span>
                <span className="text-muted-foreground/30">•</span>
                <span className="text-muted-foreground">
                  {session.interview_state.progress.answered} ИЗ {session.interview_state.progress.required}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {session.interview_state?.available_actions?.includes('continue_editing') && (
            <Button
              variant="outline"
              size="sm"
              className="font-semibold text-xs"
              onClick={() => textareaRef.current?.focus()}
            >
              Продолжить редактирование
            </Button>
          )}
          {session.has_document && (
            <Button
              variant="outline"
              size="sm"
              className="font-semibold text-xs"
              onClick={() => setLocation(`/preview/${numericId}`)}
            >
              <FileText className="mr-1.5 h-4 w-4" />
              Посмотреть текущую версию ТЗ
            </Button>
          )}
          {session.interview_state?.available_actions?.includes('save_draft') && (
            <Button
              variant="secondary"
              size="sm"
              className="font-semibold text-xs"
              onClick={handleSaveDraft}
              disabled={sendMessage.isPending}
            >
              Сохранить и продолжить позднее
            </Button>
          )}
          {canFinalizeNow && (
            <Button
              onClick={handleFinalize}
              disabled={finalizeSession.isPending || !isReadyToFinalize}
              size="sm"
              className="font-semibold text-xs shadow-sm active:scale-95 transition-transform"
            >
              {finalizeSession.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-2" />}
              Собрать ТЗ
            </Button>
          )}
        </div>
      </div>
      
      {session.interview_state?.progress && (
        <div className="h-[2px] w-full bg-secondary/80 overflow-hidden sticky top-[72px] sm:top-[68px] z-10">
          <div
            className="h-full bg-primary transition-all duration-700 ease-out"
            style={{ width: `${session.interview_state.progress.percent}%` }}
          />
        </div>
      )}

      {/* Chat History */}
      <ScrollArea className="flex-1 px-4 py-6 md:px-8 bg-background/50">
        <div className="space-y-6 pb-6">
          <div className="text-center text-xs text-muted-foreground/70 font-medium my-2">
            Проект начат {format(parseISO(session.created_at), "d MMMM yyyy", { locale: ru })}
          </div>
          
          {session.messages.map((msg) => {
            const isUser = msg.sender_type === 'user' || msg.role === 'user'; // Fallback for old messages
            return (
              <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} group animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                <div className={`flex gap-3 max-w-[90%] md:max-w-[75%] ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>

                  <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-1 shadow-sm text-xs font-bold ${
                    isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary border border-border/60 text-secondary-foreground'
                  }`}>
                    {isUser ? <UserIcon className="w-4 h-4" /> : <BotIcon className="w-4 h-4 text-primary" />}
                  </div>

                  <div className="space-y-1.5 flex flex-col min-w-0">
                    <div className={`flex items-baseline gap-2 px-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                        {msg.sender_label || (isUser ? 'Вы' : 'AI-менеджер')}
                      </span>
                      <span className="text-[10px] font-medium text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity">
                        {format(parseISO(msg.timestamp), "HH:mm")}
                      </span>
                    </div>
                    <div className={`px-4 py-3 rounded-2xl ${
                      isUser
                        ? 'bg-primary text-primary-foreground rounded-tr-sm shadow-sm'
                        : 'bg-card border border-border/50 shadow-sm rounded-tl-sm text-card-foreground'
                    }`}>
                      <p className="text-sm whitespace-pre-wrap leading-relaxed font-medium">
                        {msg.content}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {sendMessage.isPending && (
             <div className="flex justify-start animate-in fade-in">
               <div className="flex gap-3 max-w-[85%] flex-row">
                 <div className="w-8 h-8 rounded-full bg-secondary border border-border/60 text-secondary-foreground flex items-center justify-center shrink-0 mt-1 shadow-sm">
                   <BotIcon className="w-4 h-4 text-primary" />
                 </div>
                 <div className="space-y-1.5 flex flex-col min-w-0">
                    <div className="flex items-baseline gap-2 px-1 justify-start">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">AI-менеджер</span>
                    </div>
                    <div className="px-4 py-4 rounded-2xl bg-card border border-border/50 shadow-sm rounded-tl-sm text-card-foreground flex items-center gap-1.5 h-[44px]">
                      <span className="w-1.5 h-1.5 bg-primary/40 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 bg-primary/80 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                 </div>
               </div>
             </div>
          )}

          {isSessionActive && canFinalizeNow && !sendMessage.isPending && (
            <div className="my-6 animate-in fade-in slide-in-from-bottom-4 pt-4">
              <div className="rounded-2xl border border-primary/20 bg-primary/[0.03] backdrop-blur-sm p-5 shadow-sm flex flex-col sm:flex-row gap-4 sm:items-center justify-between">
                <div className="flex gap-4 items-start sm:items-center">
                  <div className="bg-primary/10 p-2.5 rounded-full shrink-0 flex items-center justify-center">
                    <CheckCircle className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-bold text-foreground text-sm">Все базовые требования собраны</h3>
                    <p className="text-xs font-medium text-muted-foreground mt-1">Достаточно данных для первой версии ТЗ. Вы можете оформить документ сейчас или продолжить диалог для уточнения деталей.</p>
                  </div>
                </div>
                <Button
                  onClick={handleFinalize}
                  disabled={finalizeSession.isPending}
                  className="shrink-0 font-bold shadow-sm transition-transform active:scale-95 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {finalizeSession.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileText className="w-4 h-4 mr-2" />}
                  Оформить ТЗ
                </Button>
              </div>
            </div>
          )}

          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input Area */}
      <div className="p-4 md:p-6 bg-card border-t shadow-[0_-4px_24px_rgba(0,0,0,0.02)] z-10 relative">

        {/* Missing Questions Panel */}
        {isShowingMissing && session.interview_state?.missing_questions?.length > 0 && (
          <div className="mb-4 bg-background border border-border/80 rounded-xl p-4 animate-in fade-in slide-in-from-bottom-2 shadow-sm">
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-border/50">
              <h4 className="text-sm font-bold flex items-center gap-2 text-foreground">
                <ListTodo className="w-4 h-4 text-primary" />
                Осталось обсудить
              </h4>
              <Button variant="ghost" size="icon" className="w-6 h-6 rounded-full hover:bg-muted text-muted-foreground" onClick={() => setIsShowingMissing(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="space-y-4">
              {session.interview_state.missing_questions.map((q, i) => (
                <div key={q.key} className="text-sm flex gap-3 items-start">
                  <div className="bg-secondary border rounded-md w-6 h-6 flex items-center justify-center shrink-0 text-xs font-bold text-secondary-foreground shadow-sm mt-0.5">
                    {i + 1}
                  </div>
                  <div>
                    <p className="font-bold text-foreground leading-tight">{q.title}</p>
                    <p className="text-muted-foreground font-medium text-xs mt-1 leading-relaxed">{q.question}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Actions */}
        {isSessionActive && quickActions.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {quickActions.includes('continue_interview') && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full text-xs font-bold hover:bg-primary hover:text-primary-foreground transition-colors shadow-sm"
                onClick={() => handleSendQuickCommand("Продолжить")}
                disabled={sendMessage.isPending}
              >
                <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
                Продолжить
              </Button>
            )}
            {quickActions.includes('show_missing') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={`rounded-full text-xs font-bold transition-colors shadow-sm ${isShowingMissing ? 'bg-primary/10 border-primary/30 text-primary' : 'hover:bg-muted bg-background'}`}
                onClick={() => setIsShowingMissing(!isShowingMissing)}
              >
                <AlertCircle className="w-3.5 h-3.5 mr-1.5" />
                {isShowingMissing ? "Скрыть список вопросов" : "Показать недостающие детали"}
              </Button>
            )}
            {quickActions.includes('retry') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-full text-xs font-bold hover:bg-muted bg-background shadow-sm"
                onClick={() => handleSendQuickCommand("Повторить")}
                disabled={sendMessage.isPending}
              >
                <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
                Повторить
              </Button>
            )}
          </div>
        )}

        {attachments.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {attachments.map((file) => (
              <div key={file.id} className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-xs shadow-sm">
                <FileText className="h-3.5 w-3.5 text-primary" />
                <span className="max-w-40 truncate font-semibold">{file.name}</span>
                <span className="text-muted-foreground font-medium">{Math.ceil(file.size / 1024)} КБ</span>
                <button type="button" onClick={() => deleteReference(file.id)} className="text-muted-foreground hover:text-destructive transition-colors ml-1" aria-label={`Удалить ${file.name}`}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <form onSubmit={handleSend} className="relative flex items-end gap-2 bg-background border rounded-2xl shadow-sm focus-within:ring-1 focus-within:ring-primary focus-within:border-primary transition-all p-2">
          <input
            ref={attachmentInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.txt,.md,.json,image/png,image/jpeg,image/webp"
            onChange={(event) => uploadReference(event.target.files?.[0])}
          />
          <div className="flex flex-col gap-1 justify-end pb-1 pl-1 shrink-0">
            <Button type="button" variant="ghost" size="icon" className="w-8 h-8 text-muted-foreground rounded-full hover:bg-muted transition-colors" title="Прикрепить файл" disabled={isUploading} onClick={() => attachmentInputRef.current?.click()}>
              {isUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
            </Button>
          </div>
          
            <Textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isSessionActive
                ? "Опишите задачу, добавьте детали или ответьте на вопросы..."
                : "Напишите, что нужно дополнить или изменить в готовом ТЗ..."
            }
            className="min-h-[40px] max-h-[200px] border-none shadow-none focus-visible:ring-0 resize-none py-3 px-2 bg-transparent w-full scrollbar-hide text-base font-medium placeholder:text-muted-foreground/60"
            rows={1}
            disabled={sendMessage.isPending || finalizeSession.isPending}
          />
          
          <div className="flex flex-col gap-1 justify-end pb-1 pr-1 shrink-0">
            {content.trim() ? (
              <Button type="submit" size="icon" className="w-10 h-10 rounded-full bg-primary text-primary-foreground shadow-md hover:scale-105 active:scale-95 transition-transform" disabled={sendMessage.isPending || finalizeSession.isPending}>
                <Send className="w-4 h-4" />
              </Button>
            ) : (
              <Button 
                type="button" 
                size="icon" 
                variant={isRecording ? "destructive" : "ghost"}
                className={`w-10 h-10 rounded-full transition-colors ${isRecording ? 'animate-pulse bg-destructive/10 text-destructive' : 'text-muted-foreground hover:bg-muted'}`}
                onClick={isRecording ? stopRecording : startRecording}
                 disabled={isTranscribing || sendMessage.isPending || finalizeSession.isPending}
                title="Голосовой ввод"
              >
                {isTranscribing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Mic className="w-5 h-5" />}
              </Button>
            )}
          </div>
        </form>
        <div className="text-center mt-2.5">
          <p className="text-[11px] text-muted-foreground/80 font-bold uppercase tracking-wider">
            {isRecording ? "Идет запись — нажмите на микрофон, чтобы завершить" : voiceError || attachmentError || chatError || "Shift + Enter для переноса строки • Markdown поддерживается"}
          </p>
        </div>
      </div>
    </div>
  );
}
