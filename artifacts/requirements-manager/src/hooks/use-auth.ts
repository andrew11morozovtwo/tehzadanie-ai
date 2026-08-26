import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

export function useAuth() {
  const { data: user, isLoading, error } = useGetMe({
    query: {
      queryKey: getGetMeQueryKey(),
      retry: false,
      staleTime: 5 * 60 * 1000,
    }
  });

  const queryClient = useQueryClient();
  const invalidateAuth = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
  }, [queryClient]);

  return {
    user,
    isLoading,
    isAuthenticated: !!user,
    error,
    invalidateAuth
  };
}
