const childProcess = require('child_process');
const {EventEmitter} = require('events');
const errorUtils = require('./errorUtils');

const childModule =
  parseInt(process.versions.node, 10) < 8
    ? require.resolve('../../lib/workerfarm/child')
    : require.resolve('../../src/workerfarm/child');

let WORKER_ID = 0;

class Worker extends EventEmitter {
  constructor(options, bundlerOptions) {
    super();

    this.options = options;
    this._bundlerOptions = bundlerOptions;
    this.id = WORKER_ID++;

    this.sendQueue = [];
    this.processQueue = true;

    this.calls = new Map();
    this.exitCode = null;
    this.callId = 0;
    this.stopped = false;
    this.ready = false;
    this.childInitialised = false;
  }

  set bundlerOptions(bundlerOptions) {
    this.ready = false;
    this._bundlerOptions = bundlerOptions;
  }

  async fork(forkModule) {
    let filteredArgs = process.execArgv.filter(
      v => !/^--(debug|inspect)/.test(v)
    );

    let options = {
      execArgv: filteredArgs,
      env: process.env,
      cwd: process.cwd()
    };

    this.child = childProcess.fork(childModule, process.argv, options);

    this.child.on('message', this.receive.bind(this));

    this.child.once('exit', code => {
      this.exitCode = code;
      this.emit('exit', code);
    });

    this.child.on('error', err => {
      this.emit('error', err);
    });

    await new Promise((resolve, reject) => {
      this.call({
        method: 'childInit',
        args: [forkModule],
        retries: 0,
        resolve: (...args) => {
          this.childInitialised = true;
          this.emit('child-init');
          resolve(...args);
        },
        reject
      });
    });

    await this.init();
  }

  async init() {
    if (!this.childInitialised) {
      await new Promise(resolve => this.once('child-init', resolve));
    }

    this.ready = false;

    return new Promise((resolve, reject) => {
      this.call({
        method: 'init',
        args: [this._bundlerOptions],
        retries: 0,
        resolve: (...args) => {
          this.ready = true;
          this.emit('ready');
          resolve(...args);
        },
        reject
      });
    });
  }

  send(data) {
    if (!this.processQueue) {
      return this.sendQueue.push(data);
    }

    let result = this.child.send(data, error => {
      if (error && error instanceof Error) {
        // Ignore this, the workerfarm handles child errors
        return;
      }

      this.processQueue = true;

      if (this.sendQueue.length > 0) {
        let queueCopy = this.sendQueue.slice(0);
        this.sendQueue = [];
        queueCopy.forEach(entry => this.send(entry));
      }
    });

    if (!result || /^win/.test(process.platform)) {
      // Queue is handling too much messages throttle it
      this.processQueue = false;
    }
  }

  call(call) {
    let idx = this.callId++;
    this.calls.set(idx, call);

    this.send({
      type: 'request',
      idx: idx,
      child: this.id,
      method: call.method,
      args: call.args
    });
  }

  receive(data) {
    if (this.stopped) {
      return;
    }

    let idx = data.idx;
    let type = data.type;
    let content = data.content;
    let contentType = data.contentType;

    if (type === 'request') {
      this.emit('request', data);
    } else if (type === 'response') {
      let call = this.calls.get(idx);
      if (!call) {
        // Return for unknown calls, these might accur if a third party process uses workers
        return;
      }

      if (contentType === 'error') {
        call.reject(errorUtils.jsonToError(content));
      } else {
        call.resolve(content);
      }

      this.calls.delete(idx);
      this.emit('response', data);
    }
  }

  stop() {
    this.stopped = true;

    this.send('die');
    setTimeout(() => {
      if (this.exitCode === null) {
        this.child.kill('SIGKILL');
      }
    }, this.options.forcedKillTime);
  }
}

module.exports = Worker;
