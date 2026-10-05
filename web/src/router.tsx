import { createBrowserRouter, Navigate } from "react-router";
import { useSession } from "./api/session";
import { ChatPage } from "./chat/ChatPage";
import { DocsPage } from "./docs/DocsPage";
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
        { path: "chat", handle: { title: "Chat" }, element: <ChatPage /> },
        { path: "chat/:id", handle: { title: "Chat" }, element: <ChatPage /> },
        { path: "documentos", handle: { title: "Documentos" }, element: <DocsPage /> },
      ],
    },
  ],
  { basename: "/panel" },
);
