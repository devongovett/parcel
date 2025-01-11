declare module 'react-server-dom-parcel/client' {
  export function createFromFetch<T>(res: Promise<Response>): Promise<T>;
  export function createFromReadableStream<T>(
    stream: ReadableStream,
  ): Promise<T>;
  export function encodeReply(
    value: any,
  ): Promise<string | URLSearchParams | FormData>;

  type CallServerCallback = <T>(id: string, args: any[]) => Promise<T>;
  export function setServerCallback(cb: CallServerCallback): void;
}
