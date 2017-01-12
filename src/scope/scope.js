/** @flow */
import * as pathLib from 'path';
import fs from 'fs';
import { merge } from 'ramda';
import { GlobalRemotes } from '../global-config';
import flattenDependencies from './flatten-dependencies';
import ComponentObjects from './component-objects';
import { Remotes } from '../remotes';
import types from './object-registrar';
import { propogateUntil, currentDirName, pathHas, readFile, first } from '../utils';
import { BIT_HIDDEN_DIR, LATEST, OBJECTS_DIR } from '../constants';
import { ScopeJson, getPath as getScopeJsonPath } from './scope-json';
import { ScopeNotFound } from './exceptions';
import { Tmp, Environment } from './repositories';
import { BitId, BitIds } from '../bit-id';
import Component from '../consumer/bit-component';
import ComponentVersion from './component-version';
import { Repository, Ref, BitObject } from './objects';
import ComponentDependencies from './component-dependencies';
import VersionDependencies from './version-dependencies';
import SourcesRepository from './repositories/sources';

const pathHasScope = pathHas([OBJECTS_DIR, BIT_HIDDEN_DIR]);

export type ScopeDescriptor = {
  name: string
};

export type ScopeProps = {
  path: string,
  scopeJson: ScopeJson;
  created?: boolean;
  tmp?: Tmp;
  environment?: Environment;
  sources?: SourcesRepository;
  objects?: Repository;
};

export default class Scope {
  created: boolean = false;
  scopeJson: ScopeJson;
  tmp: Tmp;
  environment: Environment;
  path: string;
  sources: SourcesRepository;
  objects: Repository;

  constructor(scopeProps: ScopeProps) {
    this.path = scopeProps.path;
    this.scopeJson = scopeProps.scopeJson;
    this.created = scopeProps.created || false;
    this.tmp = scopeProps.tmp || new Tmp(this);
    this.sources = scopeProps.sources || new SourcesRepository(this);
    this.objects = scopeProps.objects || new Repository(this, types());
    this.environment = scopeProps.environment || new Environment(this);
  }

  hash() {
    return this.name();
  }

  name() {
    return this.scopeJson.name;
  }

  remotes(): Promise<Remotes> {
    const self = this;
    function mergeRemotes(globalRemotes: GlobalRemotes) {
      const globalObj = globalRemotes.toPlainObject();
      return Remotes.load(merge(globalObj, self.scopeJson.remotes));
    }

    return GlobalRemotes.load()
      .then(mergeRemotes);
  }

  describe(): ScopeDescriptor {
    return {
      name: this.name()
    };
  }

  ls() {
    // return this.sources.list();
  }

  put(consumerComponent: Component): Promise<ComponentDependencies> {
    // create component model V
    // check if component already exists V
    // if exists get create latest version object otherwise create initial version V
    // create files with refs and attach to version ?
    // flatten and set dependencies ?
    // load enrionment (tester and compiler and get hash) ?
    // build + report build ?
    // test + report test ?
    // persist models (version, component, files)
    return this.remotes().then((remotes) => {
      return consumerComponent.dependencies
        .fetch(this, remotes)
        .then((dependencies) => {
          dependencies = flattenDependencies(dependencies);
          return this.sources.addSource(consumerComponent, dependencies)
          // // @TODO make the scope install the required env
            // .then(() => this.ensureEnvironment({ testerId: , compilerId }))
            .then((component) => {
              return this.objects.persist()
                .then(() => component.toConsumerComponent(LATEST, this.objects))
                .then(consumerComp => new ComponentDependencies({ 
                  component: consumerComp,
                  dependencies 
                }));
            });
        });
    });
  }

  export(componentObjects: ComponentObjects) {
    return this.sources.merge(componentObjects.toObjects(this.objects))
      .then((component) => {
        return this.objects.persist()
          .then(() => component.collectObjects(this.objects));
      });
  }

  getExternal(bitId: BitId, remotes: Remotes): Promise<ComponentDependencies> {
    return remotes.fetch([bitId])
      .then(bitDeps => first(bitDeps));
  }

  // pull(ids: BitIds) {
  //   return this.remotes().then((remotes) => {
  //     return this.sources.getMany(ids)
  //       .then((results) => {
  //         const left = results
  //           .filter(res => !res.success)
  //           .map(res => res.error.id);

  //         return remotes.fetch(left)
  //           .then(components => 
  //             // @TODO handle merging better
  //             Promise.all(components.map(comp => this.sources.merge(comp)))
  //               .then(() => this.objects.persist())
  //               .then(() => components.concat)
  //             );
  //       });
  //   });    
  // }

  getObjects(id: BitId): Promise<ComponentObjects> {
    return this.import(id)
      .then(versionDeps => versionDeps.toObjects(this.objects));
  }


  getObject(hash: string): BitObject {
    return new Ref(hash).load(this.objects);
  }

  import(id: BitId): Promise<VersionDependencies> {
    if (!id.isLocal(this.name())) {
      return this.remotes()
        .then(remotes => this.getExternal(id, remotes));
    }
    
    return this.sources.get(id)
      .then(component => component.toComponentVersion(id.version, this.name()))
      .then(version => version.toVersionDependencies(this));
  }
 
  get(id: BitId): Promise<ComponentDependencies> {
    return this.import(id)
      .then(versionDependencies => versionDependencies.toConsumer(this.objects));
  }

  getOne(id: BitId): Promise<ComponentVersion> {
    return this.sources.get(id)
      .then(component => component.toComponentVersion(id.version));
  }

  manyOnes(bitIds: BitId[]): Promise<ComponentDependencies[]> {
    return Promise.all(bitIds.map(bitId => this.getOne(bitId)));
  }

  push(bitId: BitId, remoteName: string) {
    return this.remotes().then((remotes) => {
      const remote = remotes.get(remoteName);
      return this.sources.getObjects(bitId)
        .then(component => remote.push(component))
        .then(() => this.clean(bitId));
    });
  }

  ensureDir() {
    return this.tmp
      .ensureDir()
      .then(() => this.environment.ensureDir())
      .then(() => this.scopeJson.write(this.getPath()))
      .then(() => this.objects.ensureDir())
      .then(() => this); 
  }
  
  /**
   * list the bits in the sources directory
   **/
  // listSources(): Promise<Component[]> {
  // }

  clean(bitId: BitId) {
    return this.sources.clean(bitId);
  }

  getManyObjects(ids: BitIds) {
    return Promise.all(ids.map(id => this.getObjects(id)));
  }

  getMany(bitIds: BitIds): Promise<VersionDependencies[]> {
    return Promise.all(bitIds.map((bitId) => {
      return this.import(bitId);
    }));
  }

  getPath() {
    return this.path;
  }

  loadEnvironment(bitId: BitId): Promise<any> {
    return this.environment.get(bitId);
  }

  writeToEnvironmentsDir(component: Component) {
    return this.environment.store(component);
  }
  
  /**
   * check a bitJson compiler and tester, returns an empty promise and import environments if needed
   */
  ensureEnvironment({ testerId, compilerId }: any): Promise<any> {
    return this.environment.ensureEnvironment({ testerId, compilerId });
  }

  static create(path: string = process.cwd(), name: ?string) {
    if (pathHasScope(path)) return this.load(path);
    if (!name) name = currentDirName(); 
    const scopeJson = new ScopeJson({ name });
    return Promise.resolve(new Scope({ path, created: true, scopeJson }));
  }

  static load(absPath: string): Promise<Scope> {
    let scopePath = propogateUntil(absPath, pathHasScope);
    if (!scopePath) throw new ScopeNotFound();
    if (fs.existsSync(pathLib.join(scopePath, BIT_HIDDEN_DIR))) {
      scopePath = pathLib.join(scopePath, BIT_HIDDEN_DIR);
    }
    const path = scopePath;

    return readFile(getScopeJsonPath(scopePath))      
      .then((rawScopeJson) => {
        const scopeJson = ScopeJson.loadFromJson(rawScopeJson.toString());
        const scope = new Scope({ path, scopeJson }); 
        return scope;
      });
  }
}
