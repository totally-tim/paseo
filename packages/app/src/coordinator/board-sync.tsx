import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useCoordinatorBoardStore } from "./board-store";

/**
 * One board observer per connected host: the subscribe response carries every
 * project's snapshot and `coordinator.board.changed` keeps them current. The
 * host's store entry is cleared while disconnected so a workspace never seeds
 * from a stale board.
 */
export function CoordinatorBoardSync({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient;
}) {
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "coordinator");

  useEffect(() => {
    if (!supported || !connected) {
      useCoordinatorBoardStore.getState().clearHost(serverId);
      return;
    }
    const observation = client.observeCoordinatorBoard({});
    const unsubscribe = observation.subscribe({
      snapshot: (payload) => {
        useCoordinatorBoardStore.getState().applySnapshots(serverId, payload.snapshots);
      },
      update: (message) => {
        if (message.type !== "coordinator.board.changed") {
          return;
        }
        useCoordinatorBoardStore.getState().applyBoardChange(serverId, message.payload.snapshot);
      },
      error: (error) => {
        console.warn(`[Coordinator] Board subscription failed for ${serverId}`, error);
        // Seeding must not wait on a dead subscription; the workspace falls back
        // to the draft pane.
        useCoordinatorBoardStore.getState().markUnavailable(serverId);
      },
    });
    return () => {
      unsubscribe();
      useCoordinatorBoardStore.getState().clearHost(serverId);
      void observation
        .release()
        .catch((error) =>
          console.warn("[Coordinator] Failed to release board subscription", error),
        );
    };
  }, [client, connected, serverId, supported]);

  useEffect(() => () => useCoordinatorBoardStore.getState().clearHost(serverId), [serverId]);
  return null;
}
