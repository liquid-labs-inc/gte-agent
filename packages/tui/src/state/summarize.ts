/**
 * Generic compaction of read-only GTE data payloads into the bounded snapshot
 * summary shape (small field map + at most MAX_ROWS flat rows). Used both for
 * recording transcript snapshots and for rendering panel detail — neither
 * surface ever shows or persists raw payloads wholesale.
 */
import type { SnapshotSummary } from "../api/gte"

export const MAX_ROWS = 10
export const MAX_FIELDS = 12
const MAX_TEXT = 80

export type Cell = string | number | boolean | null

function toCell(value: unknown): Cell | undefined {
  if (value === null) return null
  switch (typeof value) {
    case "string":
      return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value
    case "number":
    case "boolean":
      return value
    default:
      return undefined
  }
}

function flatten(item: unknown): Record<string, Cell> {
  if (item === null || typeof item !== "object") {
    return { value: toCell(item) ?? String(item) }
  }
  if (Array.isArray(item)) {
    const row: Record<string, Cell> = {}
    item.slice(0, MAX_FIELDS).forEach((value, index) => {
      const cell = toCell(value)
      if (cell !== undefined) row[String(index)] = cell
    })
    return row
  }
  const row: Record<string, Cell> = {}
  let count = 0
  for (const [key, value] of Object.entries(item)) {
    if (count >= MAX_FIELDS) break
    const cell = toCell(value)
    if (cell === undefined) continue
    row[key] = cell
    count += 1
  }
  return row
}

/**
 * Compact arbitrary data: arrays become up to MAX_ROWS flattened rows;
 * objects contribute primitive entries as fields, plus rows from their first
 * array-valued property (e.g. order book bids, trades lists).
 */
export function summarizeData(data: unknown, title?: string): SnapshotSummary {
  if (Array.isArray(data)) {
    return {
      ...(title === undefined ? {} : { title }),
      rows: data.slice(0, MAX_ROWS).map(flatten),
      ...(data.length > MAX_ROWS ? { note: `showing ${MAX_ROWS} of ${data.length} rows` } : {}),
    }
  }
  if (data !== null && typeof data === "object") {
    const fields: Record<string, string> = {}
    let rows: Array<Record<string, Cell>> | undefined
    let rowSource: string | undefined
    let rowTotal = 0
    let count = 0
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        if (rows === undefined) {
          rows = value.slice(0, MAX_ROWS).map(flatten)
          rowSource = key
          rowTotal = value.length
        }
        continue
      }
      if (count >= MAX_FIELDS) continue
      const cell = toCell(value)
      if (cell === undefined) continue
      fields[key] = String(cell)
      count += 1
    }
    return {
      ...(title === undefined ? {} : { title }),
      ...(count > 0 ? { fields } : {}),
      ...(rows !== undefined && rows.length > 0 ? { rows } : {}),
      ...(rowTotal > MAX_ROWS ? { note: `${rowSource}: showing ${MAX_ROWS} of ${rowTotal}` } : {}),
    }
  }
  return {
    ...(title === undefined ? {} : { title }),
    fields: { value: String(data) },
  }
}
