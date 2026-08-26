import { Route, Switch, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Layout } from "@/components/layout";
import Login from "@/pages/login";
import Dashboard from "@/pages/dashboard";
import Chat from "@/pages/chat";
import Preview from "@/pages/preview";

const queryClient = new QueryClient();

function NotFound() {
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center text-center px-4">
      <h1 className="text-4xl font-bold mb-4">404</h1>
      <p className="text-muted-foreground mb-8">Страница не найдена</p>
      <a href="/" className="text-primary hover:underline">На главную</a>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Switch>
          <Route path="/login" component={Login} />
          <Route path="/">
            {() => <Login />}
          </Route>
          <Route path="/dashboard">
            {() => <Layout><Dashboard /></Layout>}
          </Route>
          <Route path="/chat/:id">
            {(params) => <Layout><Chat id={params.id} /></Layout>}
          </Route>
          <Route path="/preview/:id">
            {(params) => <Layout><Preview id={params.id} /></Layout>}
          </Route>
          <Route component={NotFound} />
        </Switch>
      </WouterRouter>
    </QueryClientProvider>
  );
}
