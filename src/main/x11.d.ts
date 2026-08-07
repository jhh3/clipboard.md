declare module 'x11' {
  const x11: {
    createClient: (cb: (err: Error | null, display: any) => void) => void
  }
  export = x11
}
