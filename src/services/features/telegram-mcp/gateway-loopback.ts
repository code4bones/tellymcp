import type { OutgoingDeliveryNotice } from "./src/shared/api/storage/contract";

export function hasLocalTargetSession(
  session: { sessionId: string } | null | undefined,
): boolean {
  return Boolean(session?.sessionId);
}

export function hasOutgoingDeliveryNotice(
  notices: OutgoingDeliveryNotice[],
  deliveryUuid: string,
): boolean {
  return notices.some((item) => item.deliveryUuid === deliveryUuid);
}
