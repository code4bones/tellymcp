function normalizeOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function resolveGatewayInReplyTo(
  inReplyTo: string | undefined,
  deps: {
    findMessageUuidByMessageUuid: (messageUuid: string) => Promise<string | undefined>;
    findMessageUuidByShareId: (shareId: string) => Promise<string | undefined>;
  },
): Promise<string | undefined> {
  const candidate = normalizeOptionalText(inReplyTo);
  if (!candidate) {
    return undefined;
  }

  const direct = normalizeOptionalText(
    await deps.findMessageUuidByMessageUuid(candidate),
  );
  if (direct) {
    return direct;
  }

  return normalizeOptionalText(await deps.findMessageUuidByShareId(candidate));
}
