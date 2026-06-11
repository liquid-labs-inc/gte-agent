export * as GteAddress from "./address"

import { Effect, Schema } from "effect"
import { SessionSchema } from "../session/schema"

/**
 * Canonical EVM address for address-scoped GTE reads.
 *
 * This is the session `TrackedAddress` brand re-exported under the data-layer
 * name so both surfaces share one regex and one lowercase normalization. Do
 * not define a second address codec; divergence here would let a session
 * track an address the data layer rejects (or vice versa).
 */
export const EvmAddress = SessionSchema.TrackedAddress
export type EvmAddress = SessionSchema.TrackedAddress

export class InvalidAddressError extends Schema.TaggedErrorClass<InvalidAddressError>()(
  "GteData.InvalidAddressError",
  {
    input: Schema.String,
    message: Schema.String,
  },
) {}

const decodeEvmAddress = Schema.decodeUnknownEffect(EvmAddress)

/** Validate and normalize (lowercase) an EVM address before it reaches gte-ts. */
export const decode = (input: string): Effect.Effect<EvmAddress, InvalidAddressError> =>
  decodeEvmAddress(input).pipe(
    Effect.mapError(
      () =>
        new InvalidAddressError({
          input,
          message: `Invalid EVM address: "${input}". Expected 0x followed by 40 hexadecimal characters.`,
        }),
    ),
  )
