import fs from 'fs/promises';
import path from 'path';
import fse from 'fs-extra';
import globby from 'globby';
import { fromCallback as u } from 'universalify';
import { Uri } from 'vscode';
import { BufferLike } from 'webdav';
import { createAdapter, FsStat, PathLike } from 'webdav-fs';
import { RepositoryType } from '../repository-type';
import { Settings } from '../settings';
import { Logger } from '../utils/logger';
import { TemporaryRepository } from '../utils/temporary-repository';
import { FileRepository } from './file';

interface WebDAVFS {
	mkdir: (dirPath: PathLike) => Promise<void>;
	readdir: (dirPath: PathLike, modeOrCallback?: 'node' | 'stat') => Promise<Array<string | FsStat>>;
	readFile: (filename: PathLike, encodingOrCallback?: 'utf8' | 'text' | 'binary') => Promise<string | BufferLike>;
	stat: (remotePath: PathLike) => Promise<FsStat>;
	writeFile: (filename: PathLike, data: BufferLike | string, encodingOrCallback?: 'utf8' | 'text' | 'binary') => Promise<void>;
}

export class WebDAVRepository extends FileRepository {
	protected _fs?: WebDAVFS;
	protected _url: string;
	protected _options: Record<string, any>;

	constructor(settings: Settings) { // {{{
		super(settings, TemporaryRepository.getPath(settings));

		const { type, url, ...options } = settings.repository;

		this._url = url!;
		this._options = options;
	} // }}}

	public override get type() { // {{{
		return RepositoryType.WEBDAV;
	} // }}}

	public override async download(): Promise<void> { // {{{
		this.checkInitialized();

		await this.pull();

		await super.download();
	} // }}}

	public override async initialize(): Promise<void> { // {{{
		await TemporaryRepository.initialize(this._settings, this.type, this._url, JSON.stringify(this._options));

		const fs = createAdapter(this._url, {
			...this._options,
		});

		this._fs = {
			mkdir: u(fs.mkdir) as (dirPath: PathLike) => Promise<void>,
			readdir: u(fs.readdir) as (dirPath: PathLike, modeOrCallback?: 'node' | 'stat') => Promise<Array<string | FsStat>>,
			readFile: u(fs.readFile) as (filename: PathLike, encodingOrCallback?: 'utf8' | 'text' | 'binary') => Promise<string | BufferLike>,
			stat: u(fs.stat) as (remotePath: PathLike) => Promise<FsStat>,
			writeFile: u(fs.writeFile) as (filename: PathLike, data: BufferLike | string, encodingOrCallback?: 'utf8' | 'text' | 'binary') => Promise<void>,
		};

		try {
			await this._fs.stat('/');
		}
		catch (error: unknown) {
			// @ts-expect-error
			if(error?.code === 'ECONNREFUSED') {
				Logger.error(`The connection to "${this._url}" is refused.`);
			}
			// @ts-expect-error
			else if(error?.status === 401) {
				Logger.error(`The connection to "${this._url}" isn't authorized.`);
			}
			// @ts-expect-error
			else if(error?.status === 404) {
				Logger.error(`The url "${this._url}" can't be found.`);
			}
			else {
				Logger.error(String(error));
			}

			return;
		}

		await super.initialize();
	} // }}}

	public override async terminate(): Promise<void> { // {{{
		await TemporaryRepository.terminate(this._settings);
	} // }}}

	public override async upload(): Promise<void> { // {{{
		this.checkInitialized();

		await super.upload();

		await this.push();
	} // }}}

	protected async ensureDir(dir: Uri, exists: Record<string, boolean>): Promise<void> { // {{{
		if(exists[dir.path]) {
			return;
		}

		if(dir.path !== '/') {
			await this.ensureDir(Uri.joinPath(dir, '..'), exists);
		}

		try {
			await this._fs!.stat(dir.path);
		}
		catch {
			await this._fs!.mkdir(dir.path);
		}

		exists[dir.path] = true;
	} // }}}

	protected async pull(): Promise<void> { // {{{
		Logger.info('pull from webdav');

		await fse.remove(this._rootPath);
		await fse.mkdir(this._rootPath);

		const files: FsStat[] = await this._fs!.readdir('/', 'stat') as FsStat[];
		for(const file of files) {
			if(file.isDirectory()) {
				await this.pullDirectory(path.join(this._rootPath, file.name), Uri.file(file.name));
			}
			else {
				await this.pullFile(path.join(this._rootPath, file.name), Uri.file(file.name));
			}
		}

		Logger.info('pull done');
	} // }}}

	protected async pullDirectory(localDir: string, remoteDir: Uri): Promise<void> { // {{{
		await fse.mkdir(localDir);

		const files: FsStat[] = await this._fs!.readdir(remoteDir.path, 'stat') as FsStat[];
		for(const file of files) {
			if(file.isDirectory()) {
				await this.pullDirectory(path.join(localDir, file.name), Uri.joinPath(remoteDir, file.name));
			}
			else {
				await this.pullFile(path.join(localDir, file.name), Uri.joinPath(remoteDir, file.name));
			}
		}
	} // }}}

	protected async pullFile(localFile: string, remoteFile: Uri): Promise<void> { // {{{
		const data = await this._fs!.readFile(remoteFile.path, 'utf8') as string;

		await fs.writeFile(localFile, data, 'utf8');
	} // }}}

	protected async push(): Promise<void> { // {{{
		Logger.info('push to webdav');

		const files = await globby('**', {
			cwd: this._rootPath,
			followSymbolicLinks: false,
		});

		const exists = {};

		for(const file of files) {
			await this.pushFile(path.join(this._rootPath, file), Uri.file(file), exists);
		}

		Logger.info('push done');
	} // }}}

	protected async pushFile(localFile: string, remoteFile: Uri, exists: Record<string, boolean>): Promise<void> { // {{{
		Logger.info(`push file: ${remoteFile.path}`);

		await this.ensureDir(Uri.joinPath(remoteFile, '..'), exists);

		const data = await fs.readFile(localFile, 'utf8');

		await this._fs!.writeFile(remoteFile.path, data, 'utf8');
	} // }}}
}