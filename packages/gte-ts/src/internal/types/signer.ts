import type { Hex, SignableMessage, TypedDataDefinition } from "viem";

/**
 * Abstract signer interface for the GTE SDK.
 *
 * This interface defines the minimum capabilities needed for signing operations.
 * Implementations:
 * - Server-side: `fromPrivateKey()` or `fromPrivateKeyAccount()`
 * - Web/embedded wallets: `fromWalletClient()` (in gte-web)
 * - Custom: HSM, MPC, or other signing systems
 */
export interface GteSigner {
  /**
   * The address of the signer.
   */
  readonly address: `0x${string}`;

  /**
   * Sign an EIP-712 typed data structure.
   * Sign an EIP-712 typed data structure.
   */
  signTypedData(params: TypedDataDefinition, options?: unknown): Promise<Hex>;

  /**
   * Sign an arbitrary message.
   * Used for simple message signing (e.g., authentication).
   */
  signMessage(args: { message: SignableMessage }): Promise<Hex>;
}
