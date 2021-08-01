import path from 'path';
import fs from 'fs/promises';
import createSimpleGit, { SimpleGit } from 'simple-git';
import fse from 'fs-extra';
import { RepositoryType } from '../repository-type';
import { Logger } from '../utils/logger';
import { exists } from '../utils/exists';
import { FileRepository } from './file';

export interface LocalGitSettings {
	path: string;
	branch: string;
}

export enum CommitType {
	CREATE = 'create',
	UPLOAD = 'upload',
}

export class LocalGitRepository extends FileRepository {
	protected _branch: string;
	protected _git: SimpleGit;

	constructor({ path, branch }: LocalGitSettings) { // {{{
		super({ path });

		this._git = createSimpleGit();
		this._branch = branch;
	} // }}}

	public override get type() { // {{{
		return RepositoryType.GIT;
	} // }}}

	public override async duplicateProfileTo(originalProfile: string, newProfile: string): Promise<void> { // {{{
		await super.duplicateProfileTo(originalProfile, newProfile);

		const profilePath = path.join(this._rootPath, 'profiles', newProfile);
		const gitkeepPath = path.join(profilePath, '.gitkeep');

		if(!await exists(gitkeepPath)) {
			await fs.mkdir(profilePath, { recursive: true });

			await fs.writeFile(gitkeepPath, '', 'utf-8');
		}

		return this.push(CommitType.CREATE, newProfile);
	} // }}}

	public override async initialize(): Promise<void> { // {{{
		if(!await this.pull()) {
			return Logger.error('can not pull git repository');
		}

		const profilePath = path.join(this._rootPath, 'profiles', this._profile);
		const gitkeepPath = path.join(profilePath, '.gitkeep');

		if(!await exists(gitkeepPath)) {
			await fs.mkdir(profilePath, { recursive: true });

			await fs.writeFile(gitkeepPath, '', 'utf-8');

			await this.push(CommitType.CREATE);
		}

		this._initialized = true;
	} // }}}

	public override async upload(): Promise<void> { // {{{
		await super.upload();

		await this.push(CommitType.UPLOAD);
	} // }}}

	protected async pull(): Promise<boolean> { // {{{
		await fse.ensureDir(this._rootPath);

		await this._git.cwd(this._rootPath);

		if(!await this._git.checkIsRepo()) {
			Logger.info('creating git at', this._rootPath);

			await this._git.init({
				'--initial-branch': this._branch,
			});
		}

		return true;
	} // }}}

	protected async push(type: CommitType, profile: string = this._profile): Promise<void> { // {{{
		await this._git.add('.');

		const status = await this._git.status();

		if(status.staged.length === 0) {
			Logger.info('no changes, no commit');
		}
		else {
			const message = type === CommitType.CREATE ? `${profile}: create` : `${profile}: update`;

			Logger.info(`commit: ${message}`);

			await this._git.commit(message);
		}
	} // }}}
}