import { LogEvent } from '@parcel/core';
import { Diagnostic, Diagnostifiable } from '@parcel/diagnostic';

export class Logger {
  onLog(cb: (event: LogEvent) => unknown): { dispose(): unknown };
  verbose(diagnostic: Diagnostic | Diagnostic[]): void;
  info(diagnostic: Diagnostic | Diagnostic[]): void;
  log(diagnostic: Diagnostic | Diagnostic[]): void;
  warn(diagnostic: Diagnostic | Diagnostic[]): void;
  error(input: Diagnostifiable, realOrigin?: string): void;
  progress(message: string): void;
}

declare const logger: Logger;

export default logger;