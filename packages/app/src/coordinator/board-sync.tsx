import { useEffect } from "react";
import type {
  CoordinatorBoardSubscribePayload,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { OwnedSubscription } from "@getpaseo/client";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useCoordinatorBoardStore } from "./board-store";
import { useCoordinatorProjectStore } from "./project-store";

/**
 * Bounded backoff for a failed board subscribe. A dead observation releases
 * itself, so each attempt builds a fresh one; a delivered snapshot resets the
 * budget so a subscription that worked once can fail again later.
 */
const BOARD_RETRY_MAX_ATTEMPTS = 5;
const BOARD_RETRY_BASE_MS = 1_000;
const BOARD_RETRY_MAX_MS = 30_000;

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
      useCoordinatorProjectStore.getState().clearHost(serverId);
      return;
    }
    let disposed = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let observation: OwnedSubscription<CoordinatorBoardSubscribePayload> | null = null;
    let unsubscribe: (() => void) | null = null;

    const releaseObservation = () => {
      unsubscribe?.();
      unsubscribe = null;
      const current = observation;
      observation = null;
      if (current) {
        void current
          .release()
          .catch((error) =>
            console.warn("[Coordinator] Failed to release board subscription", error),
          );
      }
    };

    const subscribeBoards = () => {
      if (disposed) {
        return;
      }
      const current = client.observeCoordinatorBoard({});
      observation = current;
      unsubscribe = current.subscribe({
        snapshot: (payload) => {
          attempts = 0;
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
          releaseObservation();
          if (disposed) {
            return;
          }
          // Seeding must not wait on a dead subscription; the workspace falls
          // back to the draft pane. The retry keeps running so the board still
          // arrives once the daemon recovers.
          useCoordinatorBoardStore.getState().markUnavailable(serverId);
          if (attempts >= BOARD_RETRY_MAX_ATTEMPTS) {
            return;
          }
          const delayMs = Math.min(BOARD_RETRY_BASE_MS * 2 ** attempts, BOARD_RETRY_MAX_MS);
          attempts += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            subscribeBoards();
          }, delayMs);
        },
      });
    };

    subscribeBoards();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      releaseObservation();
      useCoordinatorBoardStore.getState().clearHost(serverId);
      useCoordinatorProjectStore.getState().clearHost(serverId);
    };
  }, [client, connected, serverId, supported]);

  useEffect(
    () => () => {
      useCoordinatorBoardStore.getState().clearHost(serverId);
      useCoordinatorProjectStore.getState().clearHost(serverId);
    },
    [serverId],
  );
  return null;
}
