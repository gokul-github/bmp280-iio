import { createFileRoute } from "@tanstack/react-router";
import { BmpLab } from "@/components/bmp-lab";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <BmpLab />;
}
