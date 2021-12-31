declare module 'net' {
  interface Socket {
    readonly readyState: string;
  }
}
