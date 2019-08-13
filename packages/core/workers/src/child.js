// @flow

import type {
  CallRequest,
  WorkerDataResponse,
  WorkerErrorResponse,
  WorkerMessage,
  WorkerRequest,
  WorkerResponse,
  ChildImpl
} from './types';
import type {IDisposable} from '@parcel/types';
import type {WorkerApi} from './WorkerFarm';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import Logger, {patchConsole} from '@parcel/logger';
import {errorToJson, jsonToError} from '@parcel/utils';
import bus from './bus';
import Profiler from './Profiler';

// Import this to register it with the serializer in the worker
import './Handle';

type ChildCall = WorkerRequest & {|
  resolve: (result: Promise<any> | any) => void,
  reject: (error: any) => void
|};

export class Child {
  callQueue: Array<ChildCall> = [];
  childId: ?number;
  maxConcurrentCalls: number = 10;
  module: ?any;
  responseId = 0;
  responseQueue: Map<number, ChildCall> = new Map();
  loggerDisposable: IDisposable;
  child: ChildImpl;
  profiler: ?Profiler;
  workerApi: WorkerApi;

  constructor(ChildBackend: Class<ChildImpl>) {
    this.child = new ChildBackend(
      this.messageListener.bind(this),
      this.handleEnd.bind(this)
    );

    patchConsole();
    // Monitior all logging events inside this child process and forward to
    // the main process via the bus.
    this.loggerDisposable = Logger.onLog(event => {
      bus.emit('logEvent', event);
    });
  }

  workerApi = {
    callMaster: async (
      request: CallRequest,
      awaitResponse: ?boolean = true
    ): Promise<mixed> => {
      return this.addCall(request, awaitResponse);
    }
  };

  messageListener(message: WorkerMessage): void | Promise<void> {
    if (message.type === 'response') {
      return this.handleResponse(message);
    } else if (message.type === 'request') {
      return this.handleRequest(message);
    }
  }

  async send(data: WorkerMessage): Promise<void> {
    this.child.send(data);
  }

  childInit(module: string, childId: number): void {
    // $FlowFixMe this must be dynamic
    this.module = require(module);
    this.childId = childId;
  }

  async handleRequest(data: WorkerRequest): Promise<void> {
    let {idx, method, args} = data;
    let child = nullthrows(data.child);

    const responseFromContent = (content: any): WorkerDataResponse => ({
      idx,
      child,
      type: 'response',
      contentType: 'data',
      content
    });

    const errorResponseFromError = (e: Error): WorkerErrorResponse => ({
      idx,
      child,
      type: 'response',
      contentType: 'error',
      content: errorToJson(e)
    });

    let result;
    if (method === 'childInit') {
      try {
        let [moduleName] = args;
        result = responseFromContent(this.childInit(moduleName, child));
      } catch (e) {
        result = errorResponseFromError(e);
      }
    } else if (method === 'startProfile') {
      this.profiler = new Profiler();
      try {
        result = responseFromContent(await this.profiler.startProfiling());
      } catch (e) {
        result = errorResponseFromError(e);
      }
    } else if (method === 'endProfile') {
      try {
        let res = this.profiler ? await this.profiler.stopProfiling() : null;
        result = responseFromContent(res);
      } catch (e) {
        result = errorResponseFromError(e);
      }
    } else {
      try {
        result = responseFromContent(
          // $FlowFixMe
          await this.module[method](this.workerApi, ...args)
        );
      } catch (e) {
        result = errorResponseFromError(e);
      }
    }

    this.send(result);
  }

  async handleResponse(data: WorkerResponse): Promise<void> {
    let idx = nullthrows(data.idx);
    let contentType = data.contentType;
    let content = data.content;
    let call = nullthrows(this.responseQueue.get(idx));

    if (contentType === 'error') {
      invariant(typeof content !== 'string');
      call.reject(jsonToError(content));
    } else {
      call.resolve(content);
    }

    this.responseQueue.delete(idx);

    // Process the next call
    this.processQueue();
  }

  // Keep in mind to make sure responses to these calls are JSON.Stringify safe
  async addCall(
    request: CallRequest,
    awaitResponse: ?boolean = true
  ): Promise<mixed> {
    // $FlowFixMe
    let call: ChildCall = {
      ...request,
      type: 'request',
      child: this.childId,
      awaitResponse,
      resolve: () => {},
      reject: () => {}
    };

    let promise;
    if (awaitResponse) {
      promise = new Promise((resolve, reject) => {
        call.resolve = resolve;
        call.reject = reject;
      });
    }

    this.callQueue.push(call);
    this.processQueue();

    return promise;
  }

  async sendRequest(call: ChildCall): Promise<void> {
    let idx;
    if (call.awaitResponse) {
      idx = this.responseId++;
      this.responseQueue.set(idx, call);
    }

    this.send({
      idx,
      child: call.child,
      type: call.type,
      location: call.location,
      handle: call.handle,
      method: call.method,
      args: call.args,
      awaitResponse: call.awaitResponse
    });
  }

  async processQueue(): Promise<void> {
    if (!this.callQueue.length) {
      return;
    }

    if (this.responseQueue.size < this.maxConcurrentCalls) {
      this.sendRequest(this.callQueue.shift());
    }
  }

  handleEnd(): void {
    this.loggerDisposable.dispose();
  }
}
