import { FastifyPluginAsync } from 'fastify';
import fs from 'fs';
import fsp from 'fs/promises';
import { completeGoogleOAuth, createFullBackup, deleteRemoteBackup, downloadRemoteBackup, getBackupStatus, getGoogleAuthUrl, listRemoteBackups, restoreBackup, saveBackupConfig, saveServiceAccount, testBackupDestination } from '../../../../lib/backup';

const root: FastifyPluginAsync = async (fastify): Promise<void> => {
	fastify.get('/google/callback', async (request, reply) => {
		try {
			const query: any = request.query;
			if (query.error) return reply.type('text/html').send(`<h2>Google Drive authorization failed</h2><p>${query.error}</p><script>window.close()</script>`);
			const result = await completeGoogleOAuth(query.code, query.state);
			return reply.type('text/html').send(`<h2>Google Drive connected</h2><p>${result.email || ''}</p><p>You can close this window.</p><script>window.opener && window.opener.postMessage({type:'rexify-google-connected'}, '*'); window.close()</script>`);
		} catch (error: any) {
			return reply.code(400).type('text/html').send(`<h2>Google Drive connection failed</h2><p>${String(error.message || error)}</p>`);
		}
	});

	fastify.addHook('onRequest', async (request) => request.jwtVerify());
	fastify.get('/', async () => await getBackupStatus());
	fastify.post('/config', async (request) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can configure backups.');
		await saveBackupConfig(request.body as any);
		return await getBackupStatus();
	});
	fastify.get('/google/start', async (request, reply) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can connect Google Drive.');
		const result = await getGoogleAuthUrl();
		return reply.send(result);
	});
	fastify.post('/service-account', async (request, reply) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can configure backups.');
		const parts = await request.files();
		for await (const part of parts) {
			if (part.fieldname === 'file') return reply.send(await saveServiceAccount((await part.toBuffer()).toString('utf8')));
		}
		throw new Error('Upload a service-account JSON file.');
	});
	fastify.post('/test', async (request) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can test backups.');
		return await testBackupDestination();
	});
	fastify.get('/files', async (request) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can list backups.');
		return await listRemoteBackups();
	});
	fastify.delete('/files/:name', async (request) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can delete backups.');
		return await deleteRemoteBackup((request.params as any).name);
	});
	fastify.get('/files/:name/download', async (request, reply) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can download backups.');
		const result = await downloadRemoteBackup((request.params as any).name);
		reply.header('Content-Disposition', `attachment; filename="${result.name}"`).type('application/octet-stream');
		const stream = fs.createReadStream(result.file);
		stream.on('close', () => fsp.rm(result.work, { recursive: true, force: true }).catch(() => undefined));
		return reply.send(stream);
	});
	fastify.post('/run', async (request) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can start backups.');
		return await createFullBackup({ upload: (request.body as any)?.upload !== false });
	});
	fastify.post('/restore', async (request) => {
		if (request.user.teamId !== '0') throw new Error('Only the administrator can restore backups.');
		return await restoreBackup((request.body as any)?.source || undefined);
	});
};
export default root;
