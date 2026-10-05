import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { ChakraProvider } from "@chakra-ui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { getSession, subscribeSession } from "./api/session";
import { router } from "./router";
import { system } from "./theme";

const queries = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

// What one person loaded is never shown to the next one who logs in on the same browser
let person = getSession()?.user.id;
subscribeSession(() => {
  const next = getSession()?.user.id;
  if (next !== person) {
    person = next;
    queries.clear();
  }
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ChakraProvider value={system}>
        <ThemeProvider attribute="class" disableTransitionOnChange>
          <QueryClientProvider client={queries}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </ThemeProvider>
      </ChakraProvider>
    </StrictMode>,
  );
}
