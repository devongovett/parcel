// @flow
import type {FilePath} from '@parcel/types';

export type DiagnosticHighlightLocation = {|
  // These positions are 1-based
  line: number,
  column: number
|};

export type DiagnosticSeverity = 'error' | 'warn' | 'info';

export type DiagnosticCodeHighlight = {|
  // start and end are included in the highlighted region
  start: DiagnosticHighlightLocation,
  end: DiagnosticHighlightLocation,
  message?: string
|};

export type DiagnosticCodeFrame = {|
  code: string,
  codeHighlights: DiagnosticCodeHighlight | Array<DiagnosticCodeHighlight>
|};

// A Diagnostic is a style agnostic way of emitting errors, warnings and info
// The reporter's are responsible for rendering the message, codeframes, hints, ...
export type Diagnostic = {|
  message: string,
  origin: string, // Name of plugin or file that threw this error

  // basic error data
  stack?: string,
  name?: string,

  // Asset metadata
  filePath?: FilePath,
  language?: string,

  // Codeframe data
  codeFrame?: DiagnosticCodeFrame,

  // Hints to resolve issues faster
  hints?: Array<string>
|};

export type BuildError = PrintableError & {
  diagnostic?: Array<Diagnostic>,
  ...
};

// This type should represent all error formats Parcel can encounter...
export type PrintableError = Error & {
  fileName?: string,
  codeFrame?: string,
  highlightedCodeFrame?: string,
  loc?: {
    column: number,
    line: number,
    ...
  },
  source?: string,
  ...
};

// Something that can be turned into a diagnostic...
export type Diagnostifiable =
  | Diagnostic
  | Array<Diagnostic>
  | ThrowableDiagnostic
  | PrintableError
  | string;

export function anyToDiagnostic(
  input: Diagnostifiable
): Diagnostic | Array<Diagnostic> {
  // $FlowFixMe
  let diagnostic: Diagnostic | Array<Diagnostic> = input;
  if (input instanceof ThrowableDiagnostic) {
    diagnostic = input.diagnostics;
  } else if (input instanceof Error) {
    diagnostic = errorToDiagnostic(input);
  }

  return diagnostic;
}

export function errorToDiagnostic(
  error: PrintableError | BuildError | string
): Array<Diagnostic> | Diagnostic {
  let codeFrame: DiagnosticCodeFrame | void = undefined;

  if (typeof error === 'string') {
    return {
      origin: 'Error',
      message: error,
      codeFrame
    };
  }

  // $FlowFixMe
  if (error.diagnostic) {
    // $FlowFixMe
    return error.diagnostic;
  }

  if (error.loc && error.source) {
    codeFrame = {
      code: error.source,
      codeHighlights: {
        start: {
          line: error.loc.line,
          column: error.loc.column
        },
        end: {
          line: error.loc.line,
          column: error.loc.column
        }
      }
    };
  }

  return {
    origin: 'Error',
    message: error.message,
    name: error.name,
    filePath: error.fileName,
    stack: error.highlightedCodeFrame || error.codeFrame || error.stack,
    codeFrame
  };
}

type ThrowableDiagnosticOpts = {
  diagnostic: Diagnostic | Array<Diagnostic>,
  ...
};

export default class ThrowableDiagnostic extends Error {
  diagnostics: Array<Diagnostic>;

  constructor(opts: ThrowableDiagnosticOpts) {
    let diagnostics = Array.isArray(opts.diagnostic)
      ? opts.diagnostic
      : [opts.diagnostic];

    // construct error from diagnostics...
    super(diagnostics[0].message);
    this.stack = diagnostics[0].stack || super.stack;
    this.name = diagnostics[0].name || super.name;

    this.diagnostics = diagnostics;
  }
}
