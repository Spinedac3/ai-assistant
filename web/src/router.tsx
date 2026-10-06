import { createBrowserRouter, Navigate } from "react-router";
import { RolesPage } from "./admin/RolesPage";
import { DiagnosticsPage, SettingsPage } from "./admin/SettingsPage";
import { UsagePage } from "./admin/UsagePage";
import { UsersPage } from "./admin/UsersPage";
import { useSession } from "./api/session";
import { ChatRoute } from "./chat/ChatPage";
import { DocsPage } from "./docs/DocsPage";
import { LoginPage } from "./pages/LoginPage";
import { Layout } from "./shell/Layout";
import { SourcesPage } from "./sources/SourcesPage";
import { ToolEditorRoute } from "./tools/ToolEditor";
import { ToolsPage } from "./tools/ToolsPage";

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
        { path: "chat", handle: { title: "Chat" }, element: <ChatRoute /> },
        { path: "chat/:id", handle: { title: "Chat" }, element: <ChatRoute /> },
        { path: "documentos", handle: { title: "Documentos" }, element: <DocsPage /> },
        { path: "fuentes", handle: { title: "Fuentes" }, element: <SourcesPage /> },
        { path: "usuarios", handle: { title: "Usuarios" }, element: <UsersPage /> },
        { path: "roles", handle: { title: "Roles y áreas" }, element: <RolesPage /> },
        { path: "uso", handle: { title: "Uso" }, element: <UsagePage /> },
        { path: "configuracion", handle: { title: "Configuración" }, element: <SettingsPage /> },
        { path: "diagnostico", handle: { title: "Diagnóstico" }, element: <DiagnosticsPage /> },
        { path: "herramientas", handle: { title: "Herramientas" }, element: <ToolsPage /> },
        {
          path: "herramientas/:name",
          handle: { title: "Herramienta" },
          element: <ToolEditorRoute />,
        },
      ],
    },
  ],
  { basename: "/panel" },
);
