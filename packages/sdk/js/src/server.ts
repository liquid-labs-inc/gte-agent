export type ServerProcess = {
  readonly port: number
  readonly stop: () => Promise<void>
}
