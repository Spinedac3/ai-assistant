import { Text } from "@chakra-ui/react";
import { createBrowserRouter, Navigate } from "react-router";
import { useSession } from "./api/session";
import { LoginPage } from "./pages/LoginPage";
import { Layout } from "./shell/Layout";

/**
 * Shows the panel to a person with a session, and the entrance to anyone else
 *
 * @return  The layout or the login
 */
function Gate() {
  return useSession() ? <Layout /> : <LoginPage />;
}

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: <Gate />,
      children: [
        { index: true, element: <Navigate to="/chat" replace /> },
        { path: "chat", handle: { title: "Chat" }, element: <Text>Chat</Text> },
        { path: "documentos", handle: { title: "Documentos" }, element: <Text>Documentos</Text> },
      ],
    },
  ],
  { basename: "/panel" },
);
