import { useHostRouteServerId } from "@/navigation/host-route-context";
import { GlobalCoordinatorScreen } from "@/coordinator/global-screen";

export default function GlobalCoordinatorRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <GlobalCoordinatorScreen serverId={serverId} /> : null;
}
