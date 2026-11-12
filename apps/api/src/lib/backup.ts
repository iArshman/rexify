import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execa } from 'execa';
import got from 'got';
import { decrypt, encrypt, prisma } from './common';

const BACKUP_ROOT = process.env.REXIFY_BACKUP_ROOT || '/app/backups';
const STAGING_ROOT = path.join(BACKUP_ROOT, '.rexify-staging');
const LOCK_FILE = path.join(BACKUP_ROOT, '.rexify-backup.lock');
const SOURCE_ROOT = '/app/rexify-source';
const VOLUME_ARCHIVE_IMAGE = process.env.REXIFY_BACKUP_VOLUME_IMAGE || 'alpine:3.19';
const RCLONE_CONFIG_FILE = process.env.REXIFY_RCLONE_CONFIG || path.join(BACKUP_ROOT, '.rclone', 'rclone.conf');

export type BackupConfig = {
	enabled: boolean;
	provider: string;	destination: string | null;
	retentionRemote: number;
	retentionLocal: number;
	schedule: string | null;
	encryptionConfigured: boolean;
	lastStatus: string | null;
	lastMessage: string | null;
	lastAt: Date | null;
	lastFile: string | null;
	googleClientId?: string | null;
	googleConnected?: boolean;
	googleEmail?: string | null;
	serviceAccountConfigured?: boolean;
};

let running = false;
let lastScheduleKey = '';

async function command(command: string, args: string[] = [], options: any = {}) {
	return await execa(command, args, { reject: true, env: { ...process.env, RCLONE_CONFIG: RCLONE_CONFIG_FILE }, ...options });
}

async function exists(file: string) {
	try { await fs.access(file); return true; } catch { return false; }
}

async function mkdir(dir: string) { await fs.mkdir(dir, { recursive: true }); }

function safeName(value: string) {
	return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 180);
}

function sha256(file: string) {
	return new Promise<string>((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fsSync.createReadStream(file);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

async function readConfig(): Promise<BackupConfig> {
	const settings: any = await prisma.setting.findUnique({ where: { id: '0' } });
	return {
		enabled: Boolean(settings?.backupEnabled),
		provider: settings?.backupProvider || 'rclone',
		destination: settings?.backupDestination || null,
		retentionRemote: settings?.backupRetentionRemote ?? 7,
		retentionLocal: settings?.backupRetentionLocal ?? 1,
		schedule: settings?.backupSchedule || null,
		encryptionConfigured: Boolean(settings?.backupEncryptionKey),
		lastStatus: settings?.backupLastStatus || null,
		lastMessage: settings?.backupLastMessage || null,
		lastAt: settings?.backupLastAt || null,
		lastFile: settings?.backupLastFile || null,
		googleClientId: settings?.backupGoogleClientId || null,
		googleConnected: Boolean(settings?.backupGoogleRefreshToken),
		googleEmail: settings?.backupGoogleEmail || null,
		serviceAccountConfigured: Boolean(settings?.backupServiceAccountJson)
	};
}

async function encryptionKey() {
	const raw = process.env.REXIFY_BACKUP_ENCRYPTION_KEY;
	if (raw) return raw;
	const settings: any = await prisma.setting.findUnique({ where: { id: '0' } });
	if (!settings?.backupEncryptionKey) throw new Error('Backup encryption key is not configured. Configure it before creating a backup.');
	return decrypt(settings.backupEncryptionKey);
}

async function acquireLock() {
	if (running || await exists(LOCK_FILE)) throw new Error('Another Rexify backup or restore is already running.');
	running = true;
	await mkdir(BACKUP_ROOT);
	await fs.writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
}

async function releaseLock() {
	running = false;
	await fs.rm(LOCK_FILE, { force: true });
}

async function listDockerVolumes() {
	const result = await command('docker', ['volume', 'ls', '--format', '{{.Name}}']);
	return result.stdout.split('\n').map(v => v.trim()).filter(Boolean).filter(v => /^[a-zA-Z0-9_.-]+$/.test(v));
}

async function captureDockerMetadata(dir: string) {
	const metadata = [
		['containers.json', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']],
		['volumes.json', ['volume', 'ls', '--format', '{{json .}}']],
		['networks.json', ['network', 'ls', '--format', '{{json .}}']],
		['images.json', ['images', '--no-trunc', '--format', '{{json .}}']]
	];
	for (const [name, args] of metadata as any) {
		try {
			const result = await command('docker', args);
			await fs.writeFile(path.join(dir, name), result.stdout + '\n');
		} catch (error: any) {
			await fs.writeFile(path.join(dir, name), JSON.stringify({ error: error.message }) + '\n');
		}
	}
}

async function captureVolume(volume: string, outputDir: string) {
	const archive = path.join(outputDir, `${safeName(volume)}.tar.gz`);
	const outputVolume = process.env.REXIFY_BACKUP_VOLUME || 'coolify-local-backup';
	const relativeArchive = path.relative(BACKUP_ROOT, archive).split(path.sep).join('/');
	await command('docker', [
		'run', '--rm', '-v', `${volume}:/volume:ro`, '-v', `${outputVolume}:/out`,
		VOLUME_ARCHIVE_IMAGE, 'sh', '-c', `mkdir -p "$(dirname /out/${relativeArchive})" && tar czf /out/${relativeArchive} -C /volume .`
	]);
	if (!await exists(archive)) throw new Error(`Docker volume archive was not created: ${volume}`);
}

async function copySource(staging: string) {
	const target = path.join(staging, 'rexify-source');
	await mkdir(target);
	if (await exists(SOURCE_ROOT)) {
		await command('sh', ['-c', `tar -C "${SOURCE_ROOT}" --exclude=node_modules --exclude=.git --exclude=build --exclude=backups -cf - . | tar -C "${target}" -xf -`]);
	} else {
		await fs.writeFile(path.join(target, 'SOURCE_NOT_MOUNTED.txt'), 'Mount the Rexify repository at /app/rexify-source for a complete source backup.\n');
	}
}

async function copyRcloneCredentials(staging: string) {
	const credentials = path.join(staging, 'credentials', 'rclone');
	await mkdir(credentials);
	const configFile = RCLONE_CONFIG_FILE;
	const serviceAccount = process.env.RCLONE_SERVICE_ACCOUNT_FILE;
	if (await exists(configFile)) await fs.copyFile(configFile, path.join(credentials, 'rclone.conf'));
	if (serviceAccount && await exists(serviceAccount)) await fs.copyFile(serviceAccount, path.join(credentials, 'service-account.json'));
}

async function createManifest(staging: string, volumes: string[], config: BackupConfig, fileName: string) {
	const manifest = {
		formatVersion: 1,
		product: 'rexify',
		rexifyVersion: '3.12.39',
		createdAt: new Date().toISOString(),
		hostname: os.hostname(),
		platform: process.platform,
		architecture: process.arch,
		backupFile: fileName,
		encrypted: true,
		provider: config.provider,
		volumes,
		contents: [
			'rexify-source',
			'control-plane/prod.db',
			'docker-metadata',
			'volumes'
		],
		restore: { requiresDocker: true, requiresRcloneForRemote: true, requiresEncryptionKey: true }
	};
	await fs.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
	return manifest;
}

async function uploadAndVerify(file: string, config: BackupConfig) {
	if (!config.destination) return { uploaded: false, verified: false };
	if (config.provider === 'local') {
		await mkdir(config.destination);
		const target = path.join(config.destination, path.basename(file));
		await fs.copyFile(file, target);
		const [a, b] = await Promise.all([sha256(file), sha256(target)]);
		if (a !== b) throw new Error('Local backup verification failed.');
		return { uploaded: true, verified: true };
	}
	await command('rclone', ['copyto', file, `${config.destination.replace(/\/$/, '')}/${path.basename(file)}`, '--retries', '5', '--low-level-retries', '20']);
	const remote = `${config.destination.replace(/\/$/, '')}/${path.basename(file)}`;
	const info = await command('rclone', ['size', remote, '--json']);
	const localSize = (await fs.stat(file)).size;
	const remoteSize = Number(JSON.parse(info.stdout).bytes || 0);
	if (remoteSize !== localSize) throw new Error(`Remote backup verification failed: local ${localSize} bytes, remote ${remoteSize} bytes.`);
	return { uploaded: true, verified: true };
}

async function applyRetention(config: BackupConfig, currentFile: string) {
	if (!config.destination || config.retentionRemote < 1) return;
	if (config.provider === 'local') {
		const files = (await fs.readdir(config.destination)).filter(f => f.endsWith('.age')).sort().reverse();
		for (const file of files.slice(config.retentionRemote)) await fs.rm(path.join(config.destination, file), { force: true });
		return;
	}
	const listing = await command('rclone', ['lsjson', config.destination, '--files-only', '--no-mimetype']);
	const files = JSON.parse(listing.stdout).filter((f: any) => String(f.Name).endsWith('.age')).sort((a: any, b: any) => String(b.Name).localeCompare(String(a.Name)));
	for (const item of files.slice(config.retentionRemote)) await command('rclone', ['deletefile', `${config.destination.replace(/\/$/, '')}/${item.Name}`]);
}

export async function createFullBackup(options: { upload?: boolean } = {}) {
	await acquireLock();
	const config = await readConfig();
	const started = Date.now();
	let staging = '';
	try {
		const key = await encryptionKey();
		staging = path.join(STAGING_ROOT, String(Date.now()));
		await mkdir(path.join(staging, 'control-plane'));
		await mkdir(path.join(staging, 'docker-metadata'));
		await mkdir(path.join(staging, 'volumes'));
		await copySource(staging);
		await copyRcloneCredentials(staging);
		const dbFile = path.join(staging, 'control-plane', 'prod.db');
		if (await exists('/app/db/prod.db')) await command('sqlite3', ['/app/db/prod.db', `.backup '${dbFile}'`]);
		else throw new Error('Rexify control-plane database /app/db/prod.db was not found.');
		await captureDockerMetadata(path.join(staging, 'docker-metadata'));
		const volumes = await listDockerVolumes();
		for (const volume of volumes) await captureVolume(volume, path.join(staging, 'volumes'));
		const fileName = `rexify-full-${os.hostname()}-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.tar.gz.age`;
		await createManifest(staging, volumes, config, fileName);
		const plain = path.join(BACKUP_ROOT, `${fileName}.plain`);
		const encrypted = path.join(BACKUP_ROOT, fileName);
		await command('tar', ['-czf', plain, '-C', staging, '.']);
		await command('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '310000', '-salt', '-in', plain, '-out', encrypted, '-pass', `pass:${key}`]);
		const checksum = await sha256(encrypted);
		await fs.writeFile(`${encrypted}.sha256`, `${checksum}  ${path.basename(encrypted)}\n`, { mode: 0o600 });
		await fs.rm(plain, { force: true });
		if (options.upload !== false && config.destination) {
			await uploadAndVerify(encrypted, config);
			await applyRetention(config, encrypted);
		}
		await prisma.setting.update({ where: { id: '0' }, data: { backupLastStatus: 'success', backupLastMessage: `Backup completed in ${Math.round((Date.now() - started) / 1000)}s`, backupLastAt: new Date(), backupLastFile: fileName } as any });
		return { file: encrypted, fileName, checksum, uploaded: Boolean(config.destination), verified: true };
	} catch (error: any) {
		await prisma.setting.update({ where: { id: '0' }, data: { backupLastStatus: 'failed', backupLastMessage: error.message, backupLastAt: new Date() } as any }).catch(() => undefined);
		throw error;
	} finally {
		if (staging) await fs.rm(staging, { recursive: true, force: true });
		await releaseLock();
	}
}

export async function restoreBackup(source?: string) {
	await acquireLock();
	let work = '';
	try {
		const config = await readConfig();
		const key = await encryptionKey();
		work = await fs.mkdtemp(path.join(os.tmpdir(), 'rexify-restore-'));
		let encrypted = source;
		if (!encrypted) {
			if (!config.destination) throw new Error('No backup source was provided and no remote destination is configured.');
			const remote = config.destination.replace(/\/$/, '');
			const listing = config.provider === 'local' ? (await fs.readdir(remote)).filter(f => f.endsWith('.age')).sort().reverse() : JSON.parse((await command('rclone', ['lsjson', remote, '--files-only'])).stdout).filter((f: any) => String(f.Name).endsWith('.age')).sort((a: any, b: any) => String(b.Name).localeCompare(String(a.Name))).map((f: any) => f.Name);
			if (!listing.length) throw new Error('No encrypted Rexify backups were found.');
			const name = typeof listing[0] === 'string' ? listing[0] : listing[0].Name;
			encrypted = path.join(work, name);
			if (config.provider === 'local') await fs.copyFile(path.join(remote, name), encrypted);
			else await command('rclone', ['copyto', `${remote}/${name}`, encrypted]);
		}
		if (!encrypted) throw new Error('Backup file not found.');
		const plain = path.join(work, 'backup.tar.gz');
		await command('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '310000', '-in', encrypted, '-out', plain, '-pass', `pass:${key}`]);
		const extract = path.join(work, 'extracted');
		await mkdir(extract);
		await command('tar', ['-xzf', plain, '-C', extract]);
		const manifest = JSON.parse(await fs.readFile(path.join(extract, 'manifest.json'), 'utf8'));
		if (manifest.product !== 'rexify' || manifest.formatVersion !== 1) throw new Error('Unsupported Rexify backup format.');
		await fs.copyFile('/app/db/prod.db', `/app/db/prod.db.pre-restore-${Date.now()}`).catch(() => undefined);
		await fs.copyFile(path.join(extract, 'control-plane', 'prod.db'), '/app/db/prod.db');
		return { restored: true, manifest };
	} finally {
		if (work) await fs.rm(work, { recursive: true, force: true });
		await releaseLock();
	}
}

export async function saveBackupConfig(input: any) {
	const data: any = {
		backupEnabled: Boolean(input.backupEnabled),
		backupProvider: input.backupProvider === 'local' ? 'local' : 'rclone',
		backupDestination: input.backupDestination ? String(input.backupDestination).trim() : null,
		backupRetentionRemote: Math.max(1, Number(input.backupRetentionRemote || 7)),
		backupRetentionLocal: Math.max(0, Number(input.backupRetentionLocal || 0)),
		backupSchedule: input.backupSchedule ? String(input.backupSchedule).trim() : null
	};
	if (input.encryptionKey) data.backupEncryptionKey = encrypt(String(input.encryptionKey));
	if (input.clearEncryptionKey === true) data.backupEncryptionKey = null;
	if (input.googleClientId !== undefined) data.backupGoogleClientId = input.googleClientId ? String(input.googleClientId).trim() : null;
	if (input.googleClientSecret) data.backupGoogleClientSecret = encrypt(String(input.googleClientSecret));
	return prisma.setting.update({ where: { id: '0' }, data });
}

async function writeRcloneConfig(settings: any) {
	await mkdir(path.dirname(RCLONE_CONFIG_FILE));
	let token: any = null;
	if (settings.backupGoogleRefreshToken) {
		token = { access_token: decrypt(settings.backupGoogleAccessToken || ''), token_type: 'Bearer', refresh_token: decrypt(settings.backupGoogleRefreshToken), expiry: settings.backupGoogleTokenExpiry?.toISOString?.() };
	}
	let content = '[gdrive]\ntype = drive\nscope = drive\n';
	if (settings.backupGoogleClientId) content += `client_id = ${settings.backupGoogleClientId}\n`;
	if (settings.backupGoogleClientSecret) content += `client_secret = ${decrypt(settings.backupGoogleClientSecret)}\n`;
	if (token) content += `token = ${JSON.stringify(token)}\n`;
	if (settings.backupServiceAccountJson) {
		const serviceFile = path.join(path.dirname(RCLONE_CONFIG_FILE), 'service-account.json');
		await fs.writeFile(serviceFile, decrypt(settings.backupServiceAccountJson), { mode: 0o600 });
		content += `service_account_file = ${serviceFile}\n`;
	}
	await fs.writeFile(RCLONE_CONFIG_FILE, content, { mode: 0o600 });
}

export async function getGoogleAuthUrl() {
	const settings: any = await prisma.setting.findUnique({ where: { id: '0' } });
	if (!settings?.backupGoogleClientId || !settings?.backupGoogleClientSecret) throw new Error('Save a Google OAuth client ID and client secret first.');
	const state = crypto.randomBytes(32).toString('hex');
	await prisma.setting.update({ where: { id: '0' }, data: { backupGoogleOAuthState: state } as any });
	const redirect = process.env.REXIFY_GOOGLE_REDIRECT_URI || `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/v1/backups/google/callback`;
	const query = new URLSearchParams({ client_id: settings.backupGoogleClientId, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/drive' });
	return { url: `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`, redirectUri: redirect };
}

export async function completeGoogleOAuth(code: string, state: string) {
	const settings: any = await prisma.setting.findUnique({ where: { id: '0' } });
	if (!settings?.backupGoogleOAuthState || state !== settings.backupGoogleOAuthState) throw new Error('Invalid or expired Google OAuth state.');
	const redirect = process.env.REXIFY_GOOGLE_REDIRECT_URI || `${process.env.PUBLIC_URL || 'http://localhost:3000'}/api/v1/backups/google/callback`;
	const secret = decrypt(settings.backupGoogleClientSecret);
	const token: any = await got.post('https://oauth2.googleapis.com/token', { form: { code, client_id: settings.backupGoogleClientId, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' } }).json();
	const access = token.access_token;
	const profile: any = await got.get('https://www.googleapis.com/drive/v3/about', { searchParams: { fields: 'user(emailAddress)' }, headers: { authorization: `Bearer ${access}` } }).json();
	await prisma.setting.update({ where: { id: '0' }, data: { backupGoogleAccessToken: encrypt(access), backupGoogleRefreshToken: token.refresh_token ? encrypt(token.refresh_token) : settings.backupGoogleRefreshToken, backupGoogleTokenExpiry: new Date(Date.now() + Number(token.expires_in || 3600) * 1000), backupGoogleEmail: profile.user?.emailAddress, backupGoogleOAuthState: null, backupProvider: 'rclone' } as any });
	const updated: any = await prisma.setting.findUnique({ where: { id: '0' } });
	await writeRcloneConfig(updated);
	return { email: profile.user?.emailAddress };
}

export async function saveServiceAccount(json: string) {
	const parsed = JSON.parse(json);
	if (!parsed.client_email || !parsed.private_key) throw new Error('Invalid service-account JSON.');
	await prisma.setting.update({ where: { id: '0' }, data: { backupServiceAccountJson: encrypt(json), backupProvider: 'rclone' } as any });
	const settings: any = await prisma.setting.findUnique({ where: { id: '0' } });
	await writeRcloneConfig(settings);
	return { email: parsed.client_email };
}

export async function testBackupDestination() {
	const config = await readConfig();
	if (!config.destination) throw new Error('Set a backup destination first.');
	const result = await command('rclone', ['lsd', config.destination]);
	return { ok: true, output: result.stdout };
}

export async function listRemoteBackups() {
	const config = await readConfig();
	if (!config.destination) throw new Error('Set a backup destination first.');
	const result = await command('rclone', ['lsjson', config.destination, '--files-only', '--no-mimetype']);
	return JSON.parse(result.stdout).filter((item: any) => String(item.Name).endsWith('.tar.gz.age') || String(item.Name).endsWith('.sha256'));
}

export async function deleteRemoteBackup(name: string) {
	if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error('Invalid backup filename.');
	const config = await readConfig();
	if (!config.destination) throw new Error('Set a backup destination first.');
	await command('rclone', ['deletefile', `${config.destination.replace(/\/$/, '')}/${name}`]);
	return { deleted: name };
}

export async function downloadRemoteBackup(name: string) {
	if (!/^[a-zA-Z0-9_.-]+\.tar\.gz\.age$/.test(name)) throw new Error('Invalid backup filename.');
	const config = await readConfig();
	if (!config.destination) throw new Error('Set a backup destination first.');
	const work = await fs.mkdtemp(path.join(os.tmpdir(), 'rexify-download-'));
	const file = path.join(work, name);
	await command('rclone', ['copyto', `${config.destination.replace(/\/$/, '')}/${name}`, file]);
	return { file, work, name };
}

export function startBackupScheduler() {
	setInterval(async () => {
		try {
			const config = await readConfig();
			if (!config.enabled || !config.schedule || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.schedule)) return;
			const now = new Date();
			const key = `${now.toISOString().slice(0, 10)}-${config.schedule}`;
			if (`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}` === config.schedule && key !== lastScheduleKey) {
				lastScheduleKey = key;
				await createFullBackup({ upload: true });
			}
		} catch (error) { console.error('Scheduled Rexify backup failed:', error); }
	}, 60_000).unref?.();
}
