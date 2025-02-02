// @flow

import type {DevServerOptions, Request, Response} from './types.js.flow';
import type {
  BuildSuccessEvent,
  BundleGraph,
  FilePath,
  PluginOptions,
  PackagedBundle,
} from '@parcel/types';
import type {Diagnostic} from '@parcel/diagnostic';
import type {FileSystem} from '@parcel/fs';
import type {HTTPServer, FormattedCodeFrame} from '@parcel/utils';

import invariant from 'assert';
import path from 'path';
import url from 'url';
import {
  ansiHtml,
  createHTTPServer,
  resolveConfig,
  readConfig,
  prettyDiagnostic,
  relativePath,
} from '@parcel/utils';
import serverErrors from './serverErrors';
import fs from 'fs';
import ejs from 'ejs';
import connect from 'connect';
import serveHandler from 'serve-handler';
import {createProxyMiddleware} from 'http-proxy-middleware';
import {URL} from 'url';
import fresh from 'fresh';

export function setHeaders(res: Response) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, HEAD, PUT, PATCH, POST, DELETE',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Content-Type',
  );
  res.setHeader('Cache-Control', 'max-age=0, must-revalidate');
}

const SLASH_REGEX = /\//g;

export const SOURCES_ENDPOINT = '/__parcel_source_root';
const TEMPLATE_404 = fs.readFileSync(
  path.join(__dirname, 'templates/404.html'),
  'utf8',
);

const TEMPLATE_500 = fs.readFileSync(
  path.join(__dirname, 'templates/500.html'),
  'utf8',
);
type NextFunction = (req: Request, res: Response, next?: (any) => any) => any;

export default class Server {
  pending: boolean;
  pendingRequests: Array<[Request, Response]>;
  middleware: Array<(req: Request, res: Response) => boolean>;
  options: DevServerOptions;
  rootPath: string;
  bundleGraph: BundleGraph<PackagedBundle> | null;
  requestBundle: ?(bundle: PackagedBundle) => Promise<BuildSuccessEvent>;
  errors: Array<{|
    message: string,
    stack: ?string,
    frames: Array<FormattedCodeFrame>,
    hints: Array<string>,
    documentation: string,
  |}> | null;
  stopServer: ?() => Promise<void>;

  constructor(options: DevServerOptions) {
    this.options = options;
    try {
      this.rootPath = new URL(options.publicUrl).pathname;
    } catch (e) {
      this.rootPath = options.publicUrl;
    }
    this.pending = true;
    this.pendingRequests = [];
    this.middleware = [];
    this.bundleGraph = null;
    this.requestBundle = null;
    this.errors = null;
  }

  buildStart() {
    this.pending = true;
  }

  buildSuccess(
    bundleGraph: BundleGraph<PackagedBundle>,
    requestBundle: (bundle: PackagedBundle) => Promise<BuildSuccessEvent>,
  ) {
    this.bundleGraph = bundleGraph;
    this.requestBundle = requestBundle;
    this.errors = null;
    this.pending = false;

    if (this.pendingRequests.length > 0) {
      let pendingRequests = this.pendingRequests;
      this.pendingRequests = [];
      for (let [req, res] of pendingRequests) {
        this.respond(req, res);
      }
    }
  }

  async buildError(options: PluginOptions, diagnostics: Array<Diagnostic>) {
    this.pending = false;
    this.errors = await Promise.all(
      diagnostics.map(async d => {
        let ansiDiagnostic = await prettyDiagnostic(d, options);

        return {
          message: ansiHtml(ansiDiagnostic.message),
          stack: ansiDiagnostic.stack ? ansiHtml(ansiDiagnostic.stack) : null,
          frames: ansiDiagnostic.frames.map(f => ({
            location: f.location,
            code: ansiHtml(f.code),
          })),
          hints: ansiDiagnostic.hints.map(hint => ansiHtml(hint)),
          documentation: d.documentationURL ?? '',
        };
      }),
    );
  }

  respond(req: Request, res: Response): mixed {
    if (this.middleware.some(handler => handler(req, res))) return;
    let {pathname} = url.parse(req.originalUrl || req.url);
    if (pathname == null) {
      pathname = '/';
    }

    if (this.errors) {
      return this.send500(req, res);
    } else if (path.extname(pathname) === '') {
      // If the URL doesn't start with the public path, or the URL doesn't
      // have a file extension, send the main HTML bundle.
      return this.sendIndex(req, res);
    } else if (pathname.startsWith(SOURCES_ENDPOINT)) {
      req.url = pathname.slice(SOURCES_ENDPOINT.length);
      return this.serve(
        this.options.inputFS,
        this.options.projectRoot,
        req,
        res,
        () => this.send404(req, res),
      );
    } else if (pathname.startsWith(this.rootPath)) {
      // Otherwise, serve the file from the dist folder
      req.url =
        this.rootPath === '/' ? pathname : pathname.slice(this.rootPath.length);
      if (req.url[0] !== '/') {
        req.url = '/' + req.url;
      }
      return this.serveBundle(req, res, () => this.sendIndex(req, res));
    } else {
      return this.send404(req, res);
    }
  }

  sendIndex(req: Request, res: Response) {
    if (this.bundleGraph) {
      // If the main asset is an HTML file, serve it
      let htmlBundleFilePaths = this.bundleGraph
        .getBundles()
        .filter(bundle => path.posix.extname(bundle.name) === '.html')
        .map(bundle => {
          return `/${relativePath(
            this.options.distDir,
            bundle.filePath,
            false,
          )}`;
        });

      let indexFilePath = null;
      let {pathname: reqURL} = url.parse(req.originalUrl || req.url);

      if (!reqURL) {
        reqURL = '/';
      }

      if (htmlBundleFilePaths.length === 1) {
        indexFilePath = htmlBundleFilePaths[0];
      } else {
        let bestMatch = null;
        for (let bundle of htmlBundleFilePaths) {
          let bundleDir = path.posix.dirname(bundle);
          let bundleDirSubdir = bundleDir === '/' ? bundleDir : bundleDir + '/';
          let withoutExtension = path.posix.basename(
            bundle,
            path.posix.extname(bundle),
          );
          let isIndex = withoutExtension === 'index';

          let matchesIsIndex = null;
          if (
            isIndex &&
            (reqURL.startsWith(bundleDirSubdir) || reqURL === bundleDir)
          ) {
            // bundle is /bar/index.html and (/bar or something inside of /bar/** was requested was requested)
            matchesIsIndex = true;
          } else if (reqURL == path.posix.join(bundleDir, withoutExtension)) {
            // bundle is /bar/foo.html and /bar/foo was requested
            matchesIsIndex = false;
          }
          if (matchesIsIndex != null) {
            let depth = bundle.match(SLASH_REGEX)?.length ?? 0;
            if (
              bestMatch == null ||
              // This one is more specific (deeper)
              bestMatch.depth < depth ||
              // This one is just as deep, but the bundle name matches and not just index.html
              (bestMatch.depth === depth && bestMatch.isIndex)
            ) {
              bestMatch = {bundle, depth, isIndex: matchesIsIndex};
            }
          }
        }
        indexFilePath = bestMatch?.['bundle'] ?? htmlBundleFilePaths[0];
      }

      if (indexFilePath) {
        req.url = indexFilePath;
        this.serveBundle(req, res, () => this.send404(req, res));
      } else {
        this.send404(req, res);
      }
    } else {
      this.send404(req, res);
    }
  }

  async serveBundle(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let bundleGraph = this.bundleGraph;
    if (bundleGraph) {
      let {pathname} = url.parse(req.url);
      if (!pathname) {
        this.send500(req, res);
        return;
      }

      let requestedPath = path.normalize(pathname.slice(1));
      let bundle = bundleGraph
        .getBundles()
        .find(
          b =>
            path.relative(this.options.distDir, b.filePath) === requestedPath,
        );
      if (!bundle) {
        this.serveDist(req, res, next);
        return;
      }

      invariant(this.requestBundle != null);
      try {
        await this.requestBundle(bundle);
      } catch (err) {
        this.send500(req, res);
        return;
      }

      this.serveDist(req, res, next);
    } else {
      this.send404(req, res);
    }
  }

  serveDist(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> | Promise<mixed> {
    return this.serve(
      this.options.outputFS,
      this.options.distDir,
      req,
      res,
      next,
    );
  }

  async serve(
    fs: FileSystem,
    root: FilePath,
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<mixed> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // method not allowed
      res.statusCode = 405;
      res.setHeader('Allow', 'GET, HEAD');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }

    try {
      var filePath = url.parse(req.url).pathname || '';
      filePath = decodeURIComponent(filePath);
    } catch (err) {
      return this.sendError(res, 400);
    }

    filePath = path.normalize('.' + path.sep + filePath);

    // malicious path
    if (filePath.includes(path.sep + '..' + path.sep)) {
      return this.sendError(res, 403);
    }

    // join / normalize from the root dir
    if (!path.isAbsolute(filePath)) {
      filePath = path.normalize(path.join(root, filePath));
    }

    try {
      var stat = await fs.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return next(req, res);
      }

      return this.sendError(res, 500);
    }

    // Fall back to next handler if not a file
    if (!stat || !stat.isFile()) {
      return next(req, res);
    }

    if (fresh(req.headers, {'last-modified': stat.mtime.toUTCString()})) {
      res.statusCode = 304;
      res.end();
      return;
    }

    return serveHandler(
      req,
      res,
      {
        public: root,
        cleanUrls: false,
      },
      {
        lstat: path => fs.stat(path),
        realpath: path => fs.realpath(path),
        createReadStream: (path, options) => fs.createReadStream(path, options),
        readdir: path => fs.readdir(path),
      },
    );
  }

  sendError(res: Response, statusCode: number) {
    res.statusCode = statusCode;
    res.end();
  }

  send404(req: Request, res: Response) {
    res.statusCode = 404;
    res.end(TEMPLATE_404);
  }

  send500(req: Request, res: Response): void | Response {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(500);

    if (this.errors) {
      return res.end(
        ejs.render(TEMPLATE_500, {
          errors: this.errors,
          hmrOptions: this.options.hmrOptions,
        }),
      );
    }
  }

  logAccessIfVerbose(req: Request) {
    this.options.logger.verbose({
      message: `Request: ${req.headers.host}${req.originalUrl || req.url}`,
    });
  }

  /**
   * Load proxy table from package.json and apply them.
   */
  async applyProxyTable(app: any): Promise<Server> {
    // avoid skipping project root
    const fileInRoot: string = path.join(this.options.projectRoot, 'index');

    const configFilePath = await resolveConfig(
      this.options.inputFS,
      fileInRoot,
      [
        '.proxyrc.cts',
        '.proxyrc.mts',
        '.proxyrc.ts',
        '.proxyrc.cjs',
        '.proxyrc.mjs',
        '.proxyrc.js',
        '.proxyrc',
        '.proxyrc.json',
      ],
      this.options.projectRoot,
    );

    if (!configFilePath) {
      return this;
    }

    const filename = path.basename(configFilePath);

    if (filename === '.proxyrc' || filename === '.proxyrc.json') {
      let conf = await readConfig(this.options.inputFS, configFilePath);
      if (!conf) {
        return this;
      }
      let cfg = conf.config;
      if (typeof cfg !== 'object') {
        this.options.logger.warn({
          message:
            "Proxy table in '.proxyrc' should be of object type. Skipping...",
        });
        return this;
      }
      for (const [context, options] of Object.entries(cfg)) {
        // each key is interpreted as context, and value as middleware options
        app.use(createProxyMiddleware(context, options));
      }
    } else {
      let cfg = await this.options.packageManager.require(
        configFilePath,
        fileInRoot,
      );
      if (
        // $FlowFixMe
        Object.prototype.toString.call(cfg) === '[object Module]'
      ) {
        cfg = cfg.default;
      }

      if (typeof cfg !== 'function') {
        this.options.logger.warn({
          message: `Proxy configuration file '${filename}' should export a function. Skipping...`,
        });
        return this;
      }
      cfg(app);
    }

    return this;
  }

  async start(): Promise<HTTPServer> {
    const finalHandler = (req: Request, res: Response) => {
      this.logAccessIfVerbose(req);

      // Wait for the parcelInstance to finish bundling if needed
      if (this.pending) {
        this.pendingRequests.push([req, res]);
      } else {
        this.respond(req, res);
      }
    };

    const app = connect();
    app.use((req, res, next) => {
      setHeaders(res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
      }
      next();
    });

    app.use((req, res, next) => {
      if (req.url === '/__parcel_healthcheck') {
        res.statusCode = 200;
        res.write(`${Date.now()}`);
        res.end();
      } else {
        next();
      }
    });

    await this.applyProxyTable(app);
    app.use(finalHandler);

    let {server, stop} = await createHTTPServer({
      cacheDir: this.options.cacheDir,
      https: this.options.https,
      inputFS: this.options.inputFS,
      listener: app,
      outputFS: this.options.outputFS,
      host: this.options.host,
    });
    this.stopServer = stop;

    server.listen(this.options.port, this.options.host);
    return new Promise((resolve, reject) => {
      server.once('error', err => {
        this.options.logger.error(
          ({
            message: serverErrors(err, this.options.port),
          }: Diagnostic),
        );
        reject(err);
      });

      server.once('listening', () => {
        resolve(server);
      });
    });
  }

  async stop(): Promise<void> {
    invariant(this.stopServer != null);
    await this.stopServer();
    this.stopServer = null;
  }
}
