import type { PerpPosition } from "../internal/generated/types.gen";

export function isFlatPerpPosition(position: Pick<PerpPosition, "size">): boolean {
  return Number(position.size) === 0;
}
