import type { PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { GteSigner } from "../types/signer";

/**
 * Create a GteSigner from a private key hex string.
 *
 * @example
 * ```typescript
 * import { GteOrderClient, fromPrivateKey } from "gte-ts";
 *
 * const client = new GteOrderClient({
 *   signer: fromPrivateKey("0x..."),
 * });
 * ```
 */
export function fromPrivateKey(privateKey: `0x${string}`): GteSigner {
  const account = privateKeyToAccount(privateKey);
  return fromPrivateKeyAccount(account);
}

/**
 * Create a GteSigner from a viem PrivateKeyAccount.
 *
 * @example
 * ```typescript
 * import { privateKeyToAccount } from "viem/accounts";
 * import { GteOrderClient, fromPrivateKeyAccount } from "gte-ts";
 *
 * const account = privateKeyToAccount("0x...");
 * const client = new GteOrderClient({
 *   signer: fromPrivateKeyAccount(account),
 * });
 * ```
 */
export function fromPrivateKeyAccount(account: PrivateKeyAccount): GteSigner {
  return {
    address: account.address,
    signTypedData: (params, _options) => account.signTypedData(params),
    signMessage: (args) => account.signMessage(args),
  };
}
