/// <reference path="../node_modules/vscode/thenable.d.ts" />

import * as rimraf from 'rimraf';
import * as temp from 'temp';
import * as path from 'path';
import * as os from 'os';

import {
	InitializeParams,
	InitializeResult,
	TextDocumentPositionParams,
	ReferenceParams,
	Location,
	Hover,
	DocumentSymbolParams,
	SymbolInformation,
	DidOpenTextDocumentParams,
	DidCloseTextDocumentParams,
	DidChangeTextDocumentParams,
	DidSaveTextDocumentParams
} from 'vscode-languageserver';

import { TypeScriptService } from 'javascript-typescript-langserver/lib/typescript-service';
import { LanguageHandler } from 'javascript-typescript-langserver/lib/lang-handler';
import { install, info, infoAlt, parseGitHubInfo } from './yarnshim';
import { FileSystem } from 'javascript-typescript-langserver/lib/fs';
import { LayeredFileSystem, LocalRootedFileSystem, walkDirs } from './vfs';
import { uri2path } from 'javascript-typescript-langserver/lib/util';
import * as rt from 'javascript-typescript-langserver/lib/request-type';

interface HasURI {
	uri: string;
}

const yarnGlobalDir = path.join(os.tmpdir(), "tsjs-yarn-global");

console.error("Using", yarnGlobalDir, "as yarn global directory");

/**
 * BuildHandler implements the LanguageHandler interface, providing
 * handler methods for LSP operations. It wraps a TypeScriptService
 * instance (which also implements the LanguageHandler
 * interface). Before calling the corresponding method on the
 * TypeScriptService instance, a BuildHandler method will do the
 * appropriate dependency resolution and fetching. It then rewrites
 * file URIs in the response from the TypeScriptService that refer to
 * files that correspond to fetched dependencies.
 */
export class BuildHandler implements LanguageHandler {
	private remoteFs: FileSystem;
	private ls: TypeScriptService;
	private lsfs: FileSystem;
	private yarndir: string;
	private yarnOverlayRoot: string;

	// managedModuleDirs is the set of directories of modules managed
	// by the build handler. It excludes modules already vendored in
	// the repository.
	private managedModuleDirs: Set<string>;
	private managedModuleInit: Map<string, Promise<Map<string, Object>>>;

	constructor() {
		this.ls = new TypeScriptService();
		this.managedModuleDirs = new Set<string>();
		this.managedModuleInit = new Map<string, Promise<Map<string, Object>>>();
	}

	async initialize(params: InitializeParams, remoteFs: FileSystem, strict: boolean): Promise<InitializeResult> {
		const yarndir = await new Promise<string>((resolve, reject) => {
			temp.mkdir("tsjs-yarn", (err: any, dirPath: string) => err ? reject(err) : resolve(dirPath));
		});
		this.yarndir = yarndir;
		this.yarnOverlayRoot = path.join(yarndir, "workspace");
		this.remoteFs = remoteFs;

		await walkDirs(remoteFs, "/", async (p, entries) => {
			let foundPackageJson = false;
			let foundModulesDir = false;
			for (const entry of entries) {
				if (!entry.dir && entry.name === "package.json") {
					foundPackageJson = true;
				}
				if (entry.dir && entry.name === "node_modules") {
					foundModulesDir = true
				}
			}
			if (foundPackageJson && !foundModulesDir) {
				this.managedModuleDirs.add(p);
			}
		});

		const overlayFs = new LocalRootedFileSystem(this.yarnOverlayRoot);
		const lsfs = new LayeredFileSystem([overlayFs, remoteFs]);
		this.lsfs = lsfs;

		return this.ls.initialize(params, lsfs, strict);
	}

	shutdown(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			rimraf(this.yarndir, (err) => err ? reject(err) : resolve());
		});
	}

	private getManagedModuleDir(uri: string): string | null {
		const p = uri2path(uri);
		for (let d = p; true; d = path.dirname(d)) {
			if (this.managedModuleDirs.has(d)) {
				return d;
			}

			if (path.dirname(d) === d) {
				break;
			}
		}
		return null;
	}

	private async ensureDependenciesForFile(uri: string): Promise<void> {
		if (!this.managedModuleInit) {
			throw new Error("build handler is not yet initialized");
		}
		const d = this.getManagedModuleDir(uri);
		if (!d) {
			return;
		}

		let ready = this.managedModuleInit.get(d);
		if (!ready) {
			ready = install(this.remoteFs, d, yarnGlobalDir, path.join(this.yarnOverlayRoot, d)).then(async (pathToDep) => {
				await this.ls.projectManager.refreshModuleStructureAt(d);
				return pathToDep;
			}, (err) => {
				this.managedModuleInit.delete(d);
			});
			this.managedModuleInit.set(d, ready);
		}
		await ready;
	}

	private async rewriteURI(uri: string): Promise<{ uri: string, rewritten: boolean }> {
		// if uri is not in a dependency module, return untouched
		const p = uri2path(uri);
		const i = p.indexOf('/node_modules/');
		if (i === -1) {
			return { uri: uri, rewritten: false };
		}

		// if the dependency module is not managed by this build handler
		let cwd = p.substring(0, i);
		if (cwd === '') {
			cwd = '/';
		}
		if (!this.managedModuleDirs.has(cwd)) {
			return { uri: uri, rewritten: false };
		}

		// get the module package name heuristically, otherwise punt
		const cmp = p.substr(i + '/node_modules/'.length).split('/');
		const subpath = path.posix.join(...cmp.slice(1));
		let pkg: string | undefined;
		if (cmp.length >= 2 && cmp[0] === "@types") {
			pkg = cmp[0] + "/" + cmp[1];
		} else if (cmp.length >= 1) {
			pkg = cmp[0];
		}
		if (!pkg) {
			return { uri: uri, rewritten: false };
		}

		// fetch the package metadata and extract the git URL from metadata if it exists; otherwise punt
		let pkginfo;
		try {
			pkginfo = await info(cwd, yarnGlobalDir, path.join(this.yarnOverlayRoot, cwd), pkg);
		} catch (e) { }
		if (!pkginfo) {
			try {
				pkginfo = await infoAlt(this.remoteFs, cwd, yarnGlobalDir, path.join(this.yarnOverlayRoot, cwd), pkg);
			} catch (e) {
				console.error("could not rewrite dependency uri,", uri, ", due to error:", e);
				return { uri: uri, rewritten: false };
			}
		}
		if (!pkginfo.repository || !pkginfo.repository.url || pkginfo.repository.type !== 'git') {
			return { uri: uri, rewritten: false };
		}

		// parse the git URL if possible, otherwise punt
		const pkgUrlInfo = parseGitHubInfo(pkginfo.repository.url);
		if (!pkgUrlInfo || !pkgUrlInfo.repository) {
			return { uri: uri, rewritten: false };
		}

		return { uri: makeUri(pkgUrlInfo.repository.url, subpath, pkginfo.gitHead), rewritten: true };
	}

	/*
	 * rewriteURIs is a kludge until we have textDocument/xdefinition.
	 */
	private async rewriteURIs(result: any): Promise<void> {
		if (!result) {
			return;
		}

		if ((<HasURI>result).uri) {
			const { uri, rewritten } = await this.rewriteURI(result.uri);
			if (rewritten) {
				result.uri = uri;
			}
		}

		if (Array.isArray(result)) {
			for (const e of result) {
				await this.rewriteURIs(e);
			}
		} else if (typeof result === "object") {
			for (const k in result) {
				await this.rewriteURIs(result[k]);
			}
		}
	}

	async getDefinition(params: TextDocumentPositionParams): Promise<Location[]> {
		let locs: Location[] = [];
		// First, attempt to get definition before dependencies
		// fetching is finished. If it fails, wait for dependency
		// fetching to finish and then retry.
		try {
			this.ensureDependenciesForFile(params.textDocument.uri); // don't wait, but kickoff background job
			locs = await this.ls.getDefinition(params);
		} catch (e) { }
		if (!locs || locs.length === 0) {
			await this.ensureDependenciesForFile(params.textDocument.uri);
			locs = await this.ls.getDefinition(params);
		}
		await this.rewriteURIs(locs);
		return locs;
	}

	async getXdefinition(params: TextDocumentPositionParams): Promise<rt.SymbolLocationInformation[]> {
		let syms: rt.SymbolLocationInformation[] = [];
		// First, attempt to get definition before dependencies
		// fetching is finished. If it fails, wait for dependency
		// fetching to finish and then retry.
		try {
			this.ensureDependenciesForFile(params.textDocument.uri); // don't wait, but kickoff background job
			syms = await this.ls.getXdefinition(params);
		} catch (e) { }
		if (!syms || syms.length === 0) {
			await this.ensureDependenciesForFile(params.textDocument.uri);
			syms = await this.ls.getXdefinition(params);
		}

		// For symbols defined in dependencies, remove the location field and add in dependency package metadata.
		await Promise.all(syms.map(async (sym) => {
			const dep = await this.getDepContainingSymbol(sym);
			if (!dep) return;
			sym.location = undefined;
			for (const k of Object.keys(dep.attributes)) {
				sym.symbol[k] = dep.attributes[k];
			}
		}));

		await this.rewriteURIs(syms);

		return syms;
	}

	// getDepContainingSymbol returns the dependency that contains the
	// symbol or null if the symbol is not defined in a dependency.
	private async getDepContainingSymbol(sym: rt.SymbolLocationInformation): Promise<rt.DependencyReference | null> {
		const moduledir = this.getManagedModuleDir(sym.location.uri);
		if (!moduledir) {
			return null;
		}
		const pathToDep = await this.managedModuleInit.get(moduledir);
		const p = uri2path(sym.location.uri);
		for (let d = p; true; d = path.dirname(d)) {
			if (pathToDep.has(d)) {
				return { attributes: pathToDep.get(d), hints: {} };
			}

			if (path.dirname(d) === d) {
				break;
			}
		}
		return null;
	}

	async getHover(params: TextDocumentPositionParams): Promise<Hover> {
		let hover: Hover | null = null;
		// First, attempt to get hover info before dependencies
		// fetching is finished. If it fails, wait for dependency
		// fetching to finish and then retry.
		try {
			this.ensureDependenciesForFile(params.textDocument.uri); // don't wait, but kickoff background job
			hover = await this.ls.getHover(params)
		} catch (e) { }
		if (!hover) {
			await this.ensureDependenciesForFile(params.textDocument.uri);
			hover = await this.ls.getHover(params);
		}
		await this.rewriteURIs(hover)
		return hover;
	}

	getReferences(params: ReferenceParams): Promise<Location[]> {
		return this.ls.getReferences(params);
	}

	getDependencies(): Promise<rt.DependencyReference[]> {
		return this.ls.getDependencies();
	}

	getWorkspaceSymbols(params: rt.WorkspaceSymbolParamsWithLimit): Promise<SymbolInformation[]> {
		return this.ls.getWorkspaceSymbols(params);
	}

	getDocumentSymbol(params: DocumentSymbolParams): Promise<SymbolInformation[]> {
		return this.ls.getDocumentSymbol(params);
	}

	getWorkspaceReference(params: rt.WorkspaceReferenceParams): Promise<rt.ReferenceInformation[]> {
		return this.ls.getWorkspaceReference(params);
	}

	didOpen(params: DidOpenTextDocumentParams) {
		return this.ls.didOpen(params);
	}

	didChange(params: DidChangeTextDocumentParams) {
		return this.ls.didChange(params);
	}

	didClose(params: DidCloseTextDocumentParams) {
		return this.ls.didClose(params);
	}

	didSave(params: DidSaveTextDocumentParams) {
		return this.ls.didSave(params);
	}
}

function makeUri(repoUri: string, path: string, version?: string): string {
	const versionPart = version ? "?" + version : "";
	if (path.startsWith("/")) {
		path = path.substr(1);
	}
	return repoUri + versionPart + "#" + path;
}
