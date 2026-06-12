export function normalizeAccountId(accountId?: string): string {
  const trimmed = accountId?.trim() ?? "";
  const withoutPrefix =
    trimmed.startsWith("0x") || trimmed.startsWith("0X") ? trimmed.slice(2) : trimmed;
  const normalized = withoutPrefix.replace(/^0+/, "");
  return normalized.length === 0 ? "0x0" : `0x${normalized.toLowerCase()}`;
}
