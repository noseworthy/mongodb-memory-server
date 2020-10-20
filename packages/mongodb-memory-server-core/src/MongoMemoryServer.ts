import { SpawnOptions } from 'child_process';
import * as tmp from 'tmp';
import getPort from 'get-port';
import {
  assertion,
  generateDbName,
  uriTemplate,
  isNullOrUndefined,
  authDefault,
} from './util/utils';
import MongoInstance, {
  MongodOpts,
  MongoMemoryInstanceProp,
  StorageEngine,
} from './util/MongoInstance';
import { MongoBinaryOpts } from './util/MongoBinary';
import debug from 'debug';
import { EventEmitter } from 'events';
import { promises } from 'fs';
import { MongoClient } from 'mongodb';

// this is because "import {promises: {readdir}}" is not valid syntax
const { readdir } = promises;

const log = debug('MongoMS:MongoMemoryServer');

tmp.setGracefulCleanup();

/**
 * MongoMemoryServer Stored Options
 */
export interface MongoMemoryServerOpts {
  instance?: MongoMemoryInstanceProp;
  binary?: MongoBinaryOpts;
  spawn?: SpawnOptions;
  /**
   * Defining this enables automatic user creation
   */
  auth?: AutomaticAuth;
}

export interface AutomaticAuth {
  /**
   * Disable Automatic User creation
   * @default false because when defining this object it usually means that AutomaticAuth is wanted
   */
  disable?: boolean;
  /**
   * Extra Users to create besides the root user
   * @default []
   */
  extraUsers?: CreateUser[];
  /**
   * mongodb-memory-server automatically creates an root user (with "root" role)
   * @default 'mongodb-memory-server-root'
   */
  customRootName?: string;
  /**
   * mongodb-memory-server automatically creates an root user with this password
   * @default 'rootuser'
   */
  customRootPwd?: string;
  /**
   * Force to run "createAuth"
   * @default false "creatAuth" is normally only run when the given "dbPath" is empty (no files)
   */
  force?: boolean;
}

/**
 * Data used by _startUpInstance's "data" variable
 */
export interface StartupInstanceData {
  port: number;
  dbPath?: string;
  dbName: string;
  ip: string;
  storageEngine: StorageEngine;
  replSet?: string;
  tmpDir?: tmp.DirResult;
}

/**
 * Information about the currently running instance
 */
export interface MongoInstanceData extends StartupInstanceData {
  dbPath: string; // re-declare, because in this interface it is *not* optional
  instance: MongoInstance;
}

/**
 * All Events for "MongoMemoryServer"
 */
export enum MongoMemoryServerEventEnum {
  stateChange = 'stateChange',
}

/**
 * All States for "MongoMemoryServer._state"
 */
export enum MongoMemoryServerStateEnum {
  new = 'new',
  starting = 'starting',
  running = 'running',
  stopped = 'stopped',
}

/**
 * All MongoDB Built-in Roles
 * @see https://docs.mongodb.com/manual/reference/built-in-roles/
 */
export type UserRoles =
  | 'read'
  | 'readWrite'
  | 'dbAdmin'
  | 'dbOwner'
  | 'userAdmin'
  | 'clusterAdmin'
  | 'clusterManager'
  | 'clusterMonitor'
  | 'hostManager'
  | 'backup'
  | 'restore'
  | 'readAnyDatabase'
  | 'readWriteAnyDatabase'
  | 'userAdminAnyDatabase'
  | 'dbAdminAnyDatabase'
  | 'root'
  | string;

/**
 * Interface options for "db.createUser" (used for this package)
 * This interface is WITHOUT the custom options from this package
 * (Some text copied from https://docs.mongodb.com/manual/reference/method/db.createUser/#definition)
 */
export interface CreateUserMongoDB {
  /**
   * Username
   */
  createUser: string;
  /**
   * Password
   */
  pwd: string;
  /**
   * Any arbitrary information.
   * This field can be used to store any data an admin wishes to associate with this particular user.
   * @example this could be the user’s full name or employee id.
   */
  customData?: {
    [key: string]: any;
  };
  /**
   * The Roles for the user, can be an empty array
   */
  roles: ({ role: UserRoles; db: string } | UserRoles)[];
  /**
   * Specify the specific SCRAM mechanism or mechanisms for creating SCRAM user credentials.
   */
  mechanisms?: ('SCRAM-SHA-1' | 'SCRAM-SHA-256')[];
  /**
   * The authentication restrictions the server enforces on the created user.
   * Specifies a list of IP addresses and CIDR ranges from which the user is allowed to connect to the server or from which the server can accept users.
   */
  authenticationRestrictions?: {
    clientSource?: string;
    serverAddress?: string;
  }[];
  /**
   * Indicates whether the server or the client digests the password.
   * "true" - The Server digests the Password
   * "false" - The Client digests the Password
   */
  digestPassword?: boolean;
}

/**
 * Interface options for "db.createUser" (used for this package)
 * This interface is WITH the custom options from this package
 * (Some text copied from https://docs.mongodb.com/manual/reference/method/db.createUser/#definition)
 */
export interface CreateUser extends CreateUserMongoDB {
  /**
   * In which Database to create this user in
   * @default 'admin' by default the "admin" database is used
   */
  database?: string;
}

export interface MongoMemoryServer extends EventEmitter {
  // Overwrite EventEmitter's definitions (to provide at least the event names)
  emit(event: MongoMemoryServerEventEnum, ...args: any[]): boolean;
  on(event: MongoMemoryServerEventEnum, listener: (...args: any[]) => void): this;
  once(event: MongoMemoryServerEventEnum, listener: (...args: any[]) => void): this;
}

export class MongoMemoryServer extends EventEmitter {
  protected _instanceInfo?: MongoInstanceData;
  opts: MongoMemoryServerOpts;
  protected _state: MongoMemoryServerStateEnum = MongoMemoryServerStateEnum.new;
  readonly auth?: Required<AutomaticAuth>;

  /**
   * Create an Mongo-Memory-Sever Instance
   *
   * Note: because of JavaScript limitations, autoStart cannot be awaited here, use ".create" for async/await ability
   * @param opts Mongo-Memory-Sever Options
   */
  constructor(opts?: MongoMemoryServerOpts) {
    super();
    this.opts = { ...opts };

    if (!isNullOrUndefined(this.opts.auth)) {
      // assign defaults
      this.auth = authDefault(this.opts.auth);
    }
  }

  /**
   * Create an Mongo-Memory-Sever Instance that can be awaited
   * @param opts Mongo-Memory-Sever Options
   */
  static async create(opts?: MongoMemoryServerOpts): Promise<MongoMemoryServer> {
    log('Called MongoMemoryServer.create() method');
    const instance = new MongoMemoryServer({ ...opts });
    await instance.start();

    return instance;
  }

  /**
   * Change "this._state" to "newState" and emit "stateChange" with "newState"
   * @param newState The new State to set & emit
   */
  protected stateChange(newState: MongoMemoryServerStateEnum): void {
    this._state = newState;
    this.emit(MongoMemoryServerEventEnum.stateChange, newState);
  }

  /**
   * Start the in-memory Instance
   */
  async start(): Promise<boolean> {
    log('Called MongoMemoryServer.start() method');
    if (this._instanceInfo) {
      throw new Error(
        'MongoDB instance already in status startup/running/error. Use debug for more info.'
      );
    }

    this.stateChange(MongoMemoryServerStateEnum.starting);

    this._instanceInfo = await this._startUpInstance().catch((err) => {
      if (!debug.enabled('MongoMS:MongoMemoryServer')) {
        console.warn('Starting the instance failed, enable debug for more infomation');
      }
      throw err;
    });

    this.stateChange(MongoMemoryServerStateEnum.running);

    return true;
  }

  /**
   * Internal Function to start an instance
   * @private
   */
  async _startUpInstance(): Promise<MongoInstanceData> {
    log('Called MongoMemoryServer._startUpInstance() method');
    /** Shortcut to this.opts.instance */
    const instOpts = this.opts.instance ?? {};
    /**
     * This variable is used for determining if "createAuth" should be run
     */
    let isNew: boolean = true;
    const createAuth: boolean =
      !!instOpts.auth && // check if auth is even meant to be enabled
      !isNullOrUndefined(this.auth) && // check if "this.auth" is defined
      !this.auth.disable && // check that "this.auth.disable" is falsey
      (this.auth.force || isNew) && // check that either "isNew" or "this.auth.force" is "true"
      !instOpts.replSet; // dont run "createAuth" when its an replset

    const data: StartupInstanceData = {
      port: await getPort({ port: instOpts.port ?? undefined }), // do (null or undefined) to undefined
      dbName: generateDbName(instOpts.dbName),
      ip: instOpts.ip ?? '127.0.0.1',
      storageEngine: instOpts.storageEngine ?? 'ephemeralForTest',
      replSet: instOpts.replSet,
      dbPath: instOpts.dbPath,
      tmpDir: undefined,
    };

    if (instOpts.port != data.port) {
      log(`starting with port ${data.port}, since ${instOpts.port} was locked:`, data.port);
    }

    if (!data.dbPath) {
      data.tmpDir = tmp.dirSync({
        mode: 0o755,
        prefix: 'mongo-mem-',
        unsafeCleanup: true,
      });
      data.dbPath = data.tmpDir.name;

      isNew = true; // just to ensure "isNew" is "true" because an new temporary directory got created
    } else {
      log(`Checking if "${data.dbPath}}" (no new tmpDir) already has data`);
      const files = await readdir(data.dbPath);

      isNew = files.length > 0; // if there already files in the directory, assume that the database is not new
    }

    log(`Starting MongoDB instance with options: ${JSON.stringify(data)}`);

    const mongodOpts: Partial<MongodOpts> = {
      instance: {
        dbPath: data.dbPath,
        ip: data.ip,
        port: data.port,
        storageEngine: data.storageEngine,
        replSet: data.replSet,
        args: instOpts.args,
        auth: createAuth ? false : instOpts.auth, // disable "auth" for "createAuth"
      },
      binary: this.opts.binary,
      spawn: this.opts.spawn,
    };

    // After that startup MongoDB instance
    let instance = await MongoInstance.run(mongodOpts);

    // another "isNullOrUndefined" because otherwise typescript complains about "this.auth" possibly being not defined
    if (!isNullOrUndefined(this.auth) && createAuth) {
      log(`Running "createAuth" (force: "${this.auth.force}")`);
      await this.createAuth(data);

      if (data.storageEngine !== 'ephemeralForTest') {
        log('Killing No-Auth instance');
        await instance.kill();

        // TODO: change this to just change the options instead of an new instance after adding getters & setters
        log('Starting Auth Instance');
        instance = await MongoInstance.run({
          ...mongodOpts,
          instance: {
            ...mongodOpts.instance,
            auth: instOpts.auth,
          },
        });
      } else {
        console.warn(
          'Not Restarting MongoInstance for Auth\n' +
            'Storage engine is ephemeralForTest, which does not write data on shutdown, and mongodb does not allow changeing "auth" runtime'
        );
      }
    } else {
      // extra "if" to log when "disable" is set to "true"
      if (this.opts.auth?.disable) {
        log('AutomaticAuth.disable is set to "true" skipping "createAuth"');
      }
    }

    return {
      ...data,
      dbPath: data.dbPath as string, // because otherwise the types would be incompatible
      instance: instance,
    };
  }

  /**
   * Stop the current In-Memory Instance
   */
  async stop(): Promise<boolean> {
    log('Called MongoMemoryServer.stop() method');

    // just return "true" if the instance is already running / defined
    if (isNullOrUndefined(this._instanceInfo)) {
      log('Instance is already stopped, returning true');
      return true;
    }

    // assert here, just to be sure
    assertion(
      !isNullOrUndefined(this._instanceInfo.instance),
      new Error('"instanceInfo.instance" is undefined!')
    );

    log(
      `Shutdown MongoDB server on port ${
        this._instanceInfo.port
      } with pid ${this._instanceInfo.instance.getPid()}` // "undefined" would say more than ""
    );
    await this._instanceInfo.instance.kill();

    const tmpDir = this._instanceInfo.tmpDir;
    if (tmpDir) {
      log(`Removing tmpDir ${tmpDir.name}`);
      tmpDir.removeCallback();
    }

    this._instanceInfo = undefined;
    this.stateChange(MongoMemoryServerStateEnum.stopped);

    return true;
  }

  /**
   * Get Information about the currently running instance, if it is not running it returns "undefined"
   */
  get instanceInfo(): MongoInstanceData | undefined {
    return this._instanceInfo;
  }

  /**
   * Get Current state of this class
   */
  get state(): MongoMemoryServerStateEnum {
    return this._state;
  }

  /**
   * Ensure that the instance is running
   * -> throws if instance cannot be started
   */
  async ensureInstance(): Promise<MongoInstanceData> {
    log('Called MongoMemoryServer.ensureInstance() method');
    if (this._instanceInfo) {
      return this._instanceInfo;
    }

    switch (this._state) {
      case MongoMemoryServerStateEnum.running:
        throw new Error('MongoMemoryServer "_state" is "running" but "instanceInfo" is undefined!');
      case MongoMemoryServerStateEnum.new:
      case MongoMemoryServerStateEnum.stopped:
        break;
      case MongoMemoryServerStateEnum.starting:
        return new Promise((res, rej) =>
          this.once(MongoMemoryServerEventEnum.stateChange, (state) => {
            if (state != MongoMemoryServerStateEnum.running) {
              rej(
                new Error(
                  `"ensureInstance" waited for "running" but got an different state: "${state}"`
                )
              );
            }
            res(this._instanceInfo);
          })
        );
      default:
        throw new Error(`"ensureInstance" does not have an case for "${this._state}"`);
    }

    log(' - no running instance, call `start()` command');
    await this.start();
    log(' - `start()` command was succesfully resolved');

    // check again for 1. Typescript-type reasons and 2. if .start failed to throw an error
    if (!this._instanceInfo) {
      throw new Error('Ensure-Instance failed to start an instance!');
    }

    return this._instanceInfo;
  }

  /**
   * Generate the Connection string used by mongodb
   * @param otherDbName Set an custom Database name, or set this to "true" to generate an different name
   */
  getUri(otherDbName?: string | boolean): string {
    assertionInstanceInfo(this._instanceInfo);

    let dbName: string = this._instanceInfo.dbName;

    // using "if" instead of nested "?:"
    if (!isNullOrUndefined(otherDbName)) {
      // use "otherDbName" if string, otherwise generate an db-name
      dbName = typeof otherDbName === 'string' ? otherDbName : generateDbName();
    }

    return uriTemplate(this._instanceInfo.ip, this._instanceInfo.port, dbName);
  }

  /**
   * Create Users and restart instance to enable auth
   * This Function assumes "this.opts.auth" is defined / enabled
   * @param data Used to get "ip" and "port"
   *
   * @internal
   */
  async createAuth(data: StartupInstanceData): Promise<void> {
    assertion(
      !isNullOrUndefined(this.auth),
      new Error('"createAuth" got called, but "this.auth" is undefined!')
    );
    log('createAuth, options:', this.auth);
    const con: MongoClient = await MongoClient.connect(uriTemplate(data.ip, data.port, 'admin'), {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    let db = con.db('admin'); // just to ensure it is actually the "admin" database AND to have the "Db" data

    // Create the root user
    log(`Creating Root user, name: "${this.auth.customRootName}"`);
    await db.command({
      createUser: this.auth.customRootName,
      pwd: 'rootuser',
      mechanisms: ['SCRAM-SHA-256'],
      customData: {
        createBy: 'mongodb-memory-server',
        as: 'ROOTUSER',
      },
      roles: ['root'],
    } as CreateUserMongoDB);

    if (this.auth.extraUsers.length > 0) {
      log(`Creating "${this.auth.extraUsers.length}" Custom Users`);
      this.auth.extraUsers.sort((a, b) => {
        if (a.database === 'admin') {
          return -1; // try to make all "admin" at the start of the array
        }
        return a.database === b.database ? 0 : 1; // "0" to sort same databases continuesly, "-1" if nothing before/above applies
      });

      for (const user of this.auth.extraUsers) {
        user.database = isNullOrUndefined(user.database) ? 'admin' : user.database;
        // just to have not to call "con.db" everytime in the loop if its the same
        if (user.database !== db.databaseName) {
          db = con.db(user.database);
        }

        log('Creating User: ', user);
        await db.command({
          createUser: user.createUser,
          pwd: user.pwd,
          customData: user.customData ?? {},
          roles: user.roles,
          authenticationRestrictions: user.authenticationRestrictions ?? [],
          mechanisms: user.mechanisms ?? ['SCRAM-SHA-256'],
          digestPassword: user.digestPassword ?? true,
        } as CreateUserMongoDB);
      }
    }

    await con.close();
  }
}

export default MongoMemoryServer;

/**
 * This function is to de-duplicate code
 * -> this couldnt be included in the class, because "asserts this.instanceInfo" is not allowed
 * @param val this.instanceInfo
 */
function assertionInstanceInfo(val: unknown): asserts val is MongoInstanceData {
  assertion(!isNullOrUndefined(val), new Error('"instanceInfo" is undefined'));
}
