import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useLogin, useRegister } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, ArrowRight, CheckCircle2 } from "lucide-react";

export default function Login() {
  const [location, setLocation] = useLocation();
  const { isAuthenticated, invalidateAuth } = useAuth();
  
  useEffect(() => {
    if (isAuthenticated) {
      setLocation("/dashboard");
    }
  }, [isAuthenticated, setLocation]);

  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const [errorMsg, setErrorMsg] = useState("");
  const [activeTab, setActiveTab] = useState("login");
  const [issuedPassword, setIssuedPassword] = useState("");
  const [registeredEmail, setRegisteredEmail] = useState("");

  const handleLogin = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg("");
    const fd = new FormData(e.currentTarget);
    const email = fd.get("email") as string;
    const password = fd.get("password") as string;
    
    loginMutation.mutate(
      { data: { email, password } },
      {
        onSuccess: () => {
          invalidateAuth();
        },
        onError: () => {
          setErrorMsg("Неверный email или пароль.");
        }
      }
    );
  };

  const handleRegister = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg("");
    const fd = new FormData(e.currentTarget);
    const name = fd.get("name") as string;
    const email = fd.get("email") as string;
    
    registerMutation.mutate(
      { data: { name, email } },
      {
        onSuccess: (data) => {
          if (data.password) {
            setIssuedPassword(data.password);
            setRegisteredEmail(email);
            setActiveTab("login");
          } else {
            invalidateAuth();
          }
        },
        onError: () => {
          setErrorMsg("Ошибка при регистрации. Возможно, email уже используется.");
        }
      }
    );
  };

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Left side: Branding / Value Prop */}
      <div className="flex-1 bg-muted/70 text-foreground p-8 md:p-16 flex flex-col justify-between relative overflow-hidden border-b md:border-b-0 md:border-r border-border">
        <div className="absolute top-[-20%] left-[-10%] w-[150%] h-[150%] bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/10 via-transparent to-transparent pointer-events-none opacity-70" />
        
        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-16">
            <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-xl shadow-sm">
              T
            </div>
            <span className="font-bold text-2xl tracking-tight">ТехЗадание.AI</span>
          </div>
          
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] mb-6 tracking-tight">
             Идея превращается <br/>
             в <span className="text-primary">чёткое ТЗ</span>.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground max-w-lg leading-relaxed">
            Расскажите нашему AI-менеджеру о вашем проекте своими словами. 
            Мы зададим правильные вопросы и сформируем профессиональное техническое задание для разработчиков.
          </p>
        </div>
        
        <div className="relative z-10 space-y-4 hidden md:block">
          {[
            "Человеческий диалог вместо сложных анкет",
            "Автоматическая структуризация требований",
            "Готовый Markdown-документ для команды"
          ].map((feature, i) => (
            <div key={i} className="flex items-center gap-3 text-foreground/80 font-medium">
              <CheckCircle2 className="w-5 h-5 text-primary" />
              {feature}
            </div>
          ))}
        </div>
      </div>
      
      {/* Right side: Auth Form */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-12 relative">
        <div className="w-full max-w-md space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700 ease-out">
          <div className="text-center md:text-left space-y-2">
            <h2 className="text-3xl font-bold tracking-tight">Добро пожаловать</h2>
            <p className="text-muted-foreground">Войдите в систему или создайте новый аккаунт для начала работы.</p>
          </div>
          
          <Card className="border-none shadow-xl shadow-black/5">
            <CardContent className="p-1">
              <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                <TabsList className="grid w-full grid-cols-2 mb-6">
                  <TabsTrigger value="login">Вход</TabsTrigger>
                  <TabsTrigger value="register">Регистрация</TabsTrigger>
                </TabsList>
                
                <TabsContent value="login" className="p-4 md:p-6 pt-0">
                  <form onSubmit={handleLogin} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="login-email">Email</Label>
                      <Input id="login-email" name="email" type="email" placeholder="client@example.com" defaultValue={registeredEmail} autoComplete="email" required disabled={loginMutation.isPending} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="login-password">Пароль</Label>
                      <Input id="login-password" name="password" type="password" defaultValue={issuedPassword} autoComplete="current-password" required disabled={loginMutation.isPending} />
                    </div>

                    {issuedPassword ? (
                      <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                        <p className="font-semibold text-foreground">Ваш уникальный пароль</p>
                        <p className="mt-1 font-mono text-base text-primary">{issuedPassword}</p>
                        <p className="mt-1 text-muted-foreground">Копия пароля направляется на {registeredEmail}. Сохраните пароль для повторного входа.</p>
                      </div>
                    ) : null}
                    
                    {errorMsg && <p className="text-sm text-destructive font-medium">{errorMsg}</p>}
                    
                    <Button type="submit" className="w-full mt-2" size="lg" disabled={loginMutation.isPending}>
                      {loginMutation.isPending ? "Вход..." : "Войти"}
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </form>
                </TabsContent>
                
                <TabsContent value="register" className="p-4 md:p-6 pt-0">
                  <form onSubmit={handleRegister} className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="register-name">Как к вам обращаться?</Label>
                      <Input id="register-name" name="name" type="text" placeholder="Иван Иванов" autoComplete="name" required disabled={registerMutation.isPending} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="register-email">Email</Label>
                      <Input id="register-email" name="email" type="email" placeholder="client@example.com" autoComplete="email" required disabled={registerMutation.isPending} />
                    </div>
                    
                    {errorMsg && <p className="text-sm text-destructive font-medium">{errorMsg}</p>}
                    
                    <Button type="submit" className="w-full mt-2" size="lg" disabled={registerMutation.isPending || loginMutation.isPending}>
                      {(registerMutation.isPending || loginMutation.isPending) ? "Создание аккаунта..." : "Создать аккаунт"}
                      <ArrowRight className="w-4 h-4 ml-2" />
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
