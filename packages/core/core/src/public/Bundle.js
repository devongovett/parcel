// @flow strict-local
// flowlint unsafe-getters-setters:off

import type {Bundle as InternalBundle} from '../types';
import type {
  Asset,
  Bundle as IBundle,
  Dependency,
  Environment,
  FilePath,
  GraphTraversalCallback,
  MutableBundle as IMutableBundle,
  NamedBundle as INamedBundle,
  Stats,
  Target
} from '@parcel/types';

import nullthrows from 'nullthrows';

// Friendly access for other modules within this package that need access
// to the internal bundle.
export const bundleToInternal: WeakMap<IBundle, InternalBundle> = new WeakMap();

export class Bundle implements IBundle {
  #bundle; // InternalBundle

  constructor(bundle: InternalBundle) {
    this.#bundle = bundle;
    bundleToInternal.set(this, bundle);
  }

  get id(): string {
    return this.#bundle.id;
  }

  get type(): string {
    return this.#bundle.type;
  }

  get env(): Environment {
    return this.#bundle.env;
  }

  get isEntry(): ?boolean {
    return this.#bundle.isEntry;
  }

  get target(): ?Target {
    return this.#bundle.target;
  }

  get filePath(): ?FilePath {
    return this.#bundle.filePath;
  }

  get stats(): Stats {
    return this.#bundle.stats;
  }

  getDependencies(asset: Asset): Array<Dependency> {
    return this.#bundle.assetGraph.getDependencies(asset);
  }

  getDependencyResolution(dependency: Dependency): ?Asset {
    return this.#bundle.assetGraph.getDependencyResolution(dependency);
  }

  getEntryAssets(): Array<Asset> {
    return this.#bundle.assetGraph.getEntryAssets();
  }

  getTotalSize(asset?: Asset): number {
    return this.#bundle.assetGraph.getTotalSize(asset);
  }

  traverseAssets<TContext>(
    visit: GraphTraversalCallback<Asset, TContext>
  ): ?TContext {
    return this.#bundle.assetGraph.traverse((node, ...args) => {
      if (node.type === 'asset') {
        return visit(node.value, ...args);
      }
    });
  }
}

export class MutableBundle extends Bundle implements IMutableBundle {
  #bundle; // InternalBundle

  constructor(bundle: InternalBundle) {
    super(bundle);
    this.#bundle = bundle; // Repeating for flow
  }

  get filePath(): ?FilePath {
    return this.#bundle.filePath;
  }

  set filePath(filePath: ?FilePath): void {
    this.#bundle.filePath = filePath;
  }

  get isEntry(): ?boolean {
    return this.#bundle.isEntry;
  }

  set isEntry(isEntry?: ?boolean): void {
    this.#bundle.isEntry = isEntry;
  }

  get stats(): Stats {
    return this.#bundle.stats;
  }

  set stats(stats: Stats): void {
    this.#bundle.stats = stats;
  }

  removeAsset(asset: Asset): void {
    return this.#bundle.assetGraph.removeAsset(asset);
  }

  merge(bundle: IBundle): void {
    // $FlowFixMe accessing another bundle's property is fine
    let otherBundle: InternalBundle = bundle.#bundle;
    this.#bundle.assetGraph.merge(otherBundle.assetGraph);
  }
}

export class NamedBundle extends Bundle implements INamedBundle {
  #bundle; // InternalBundle

  constructor(bundle: InternalBundle) {
    super(bundle);
    this.#bundle = bundle; // Repeating for flow
  }

  get filePath(): FilePath {
    return nullthrows(this.#bundle.filePath);
  }
}
