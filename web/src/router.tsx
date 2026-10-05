import { Heading } from "@chakra-ui/react";
import { createBrowserRouter } from "react-router";

export const router = createBrowserRouter(
  [{ path: "/", element: <Heading p={6}>Asistente</Heading> }],
  { basename: "/panel" },
);
