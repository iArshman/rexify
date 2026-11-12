<script lang="ts">
	import { get, post, del } from '$lib/api';
	import Cookies from 'js-cookie';
	import { appSession, addToast } from '$lib/store';
	import { onMount } from 'svelte';

	let status: any = {}, files: any[] = [], loading = false, saving = false;
	let form = { backupEnabled: false, backupProvider: 'rclone', backupDestination: '', backupRetentionRemote: 7, backupRetentionLocal: 1, backupSchedule: '03:30', encryptionKey: '', googleClientId: '', googleClientSecret: '' };
	let serviceFile: File | null = null;

	onMount(async () => {
		window.addEventListener('message', async (event) => { if (event.data?.type === 'rexify-google-connected') { await refresh(); addToast({ message: 'Google Drive connected.', type: 'success' }); } });
		await refresh();
	});
	async function refresh() {
		status = await get('/backups');
		form = { ...form, backupEnabled: status.enabled ?? false, backupProvider: status.provider ?? 'rclone', backupDestination: status.destination ?? '', backupRetentionRemote: status.retentionRemote ?? 7, backupRetentionLocal: status.retentionLocal ?? 1, backupSchedule: status.schedule ?? '03:30', googleClientId: status.googleClientId ?? '' };
		if (status.destination) { try { files = await get('/backups/files') as any; } catch { files = []; } }
	}
	async function save() { saving = true; try { status = await post('/backups/config', form); addToast({ message: 'Backup settings saved.', type: 'success' }); } catch (e) { addToast({ message: String(e), type: 'error' }); } finally { saving = false; } }
	async function connectGoogle() { try { await post('/backups/config', { googleClientId: form.googleClientId, googleClientSecret: form.googleClientSecret }); const result: any = await get('/backups/google/start'); window.open(result.url, 'rexifyGoogleOAuth', 'width=600,height=700'); } catch (e) { addToast({ message: String(e), type: 'error', timeout: 8000 }); } }
	async function uploadServiceAccount() { if (!serviceFile) return; const data = new FormData(); data.append('file', serviceFile); try { const response = await fetch('/api/v1/backups/service-account', { method: 'POST', headers: { Authorization: `Bearer ${Cookies.get('token')}` }, body: data }); if (!response.ok) throw new Error(await response.text()); addToast({ message: 'Service account connected.', type: 'success' }); await refresh(); } catch (e) { addToast({ message: String(e), type: 'error' }); } }
	async function testConnection() { try { await post('/backups/test', {}); addToast({ message: 'Backup destination is reachable.', type: 'success' }); } catch (e) { addToast({ message: String(e), type: 'error', timeout: 8000 }); } }
	async function listFiles() { try { files = await get('/backups/files') as any; } catch (e) { addToast({ message: String(e), type: 'error' }); } }
	async function downloadFile(name: string) { try { const response = await fetch(`/api/v1/backups/files/${encodeURIComponent(name)}/download`, { headers: { Authorization: `Bearer ${Cookies.get('token')}` } }); if (!response.ok) throw new Error(await response.text()); const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); URL.revokeObjectURL(link.href); } catch (e) { addToast({ message: String(e), type: 'error' }); } }
	async function deleteFile(name: string) { if (!confirm(`Delete ${name} from remote storage?`)) return; try { await del(`/backups/files/${name}`, {}); await listFiles(); } catch (e) { addToast({ message: String(e), type: 'error' }); } }
	async function runBackup() { loading = true; try { const result: any = await post('/backups/run', { upload: true }); await refresh(); addToast({ message: `Backup completed: ${result.fileName}`, type: 'success', timeout: 12000 }); } catch (e) { await refresh(); addToast({ message: String(e), type: 'error', timeout: 12000 }); } finally { loading = false; } }
	async function restoreLatest() { if (!confirm('Restore the newest control-plane backup? Use the host script for complete server restore.')) return; loading = true; try { await post('/backups/restore', {}); addToast({ message: 'Control-plane restore completed. Restart Rexify.', type: 'success', timeout: 12000 }); } catch (e) { addToast({ message: String(e), type: 'error', timeout: 12000 }); } finally { loading = false; } }
</script>

{#if $appSession.isAdmin}
<div class="mx-auto max-w-5xl space-y-5">
	<div class="flex items-center justify-between"><h1 class="title">Full Server Backups</h1><div class="flex gap-2"><button class="btn btn-sm bg-coollabs" disabled={loading} on:click={runBackup}>{loading ? 'Working…' : 'Backup now'}</button><button class="btn btn-sm" disabled={loading || !status.destination} on:click={restoreLatest}>Restore newest</button></div></div>
	<div class="rounded border border-coolgray-500 bg-coolgray-100 p-5 space-y-4">
		<h2 class="text-xl font-bold">Google Drive connection</h2>
		<p class="text-sm text-stone-300">Use OAuth for a personal Google account, or upload a service-account JSON file. No server-side rclone configuration is required.</p>
		<div class="grid gap-3 md:grid-cols-2"><label>Google OAuth Client ID<input bind:value={form.googleClientId} placeholder="123...apps.googleusercontent.com" /></label><label>Google OAuth Client Secret<input type="password" bind:value={form.googleClientSecret} placeholder="Enter to save/update" /></label></div>
		<div class="flex flex-wrap gap-2"><button class="btn btn-sm bg-coollabs" on:click={connectGoogle}>Connect Google Drive with OAuth</button><span class="self-center text-sm">{status.googleConnected ? `Connected: ${status.googleEmail || 'Google account'}` : 'Not connected'}</span></div>
		<div class="flex flex-wrap items-center gap-2"><input type="file" accept="application/json,.json" on:change={(e) => serviceFile = e.currentTarget.files?.[0] || null} /><button class="btn btn-sm" disabled={!serviceFile} on:click={uploadServiceAccount}>Upload service-account JSON</button><span class="text-sm">{status.serviceAccountConfigured ? 'Service account configured' : ''}</span></div>
	</div>
	<div class="rounded border border-coolgray-500 bg-coolgray-100 p-5 space-y-4"><h2 class="text-xl font-bold">Backup settings</h2><p class="text-sm text-stone-300">The archive includes Rexify configuration, database, Docker volumes, bind mounts, SSL state, and metadata. It is encrypted before upload.</p><div class="grid gap-3 md:grid-cols-2"><label class="flex items-center gap-2"><input type="checkbox" bind:checked={form.backupEnabled} /> Enable daily scheduled backups</label><label>Provider<select bind:value={form.backupProvider}><option value="rclone">rclone / Google Drive / S3 / SFTP</option><option value="local">Local folder</option></select></label><label class="md:col-span-2">Destination<input bind:value={form.backupDestination} placeholder="gdrive:rexify-backups" /></label><label>Daily time<input bind:value={form.backupSchedule} placeholder="03:30" /></label><label>Remote backups to keep<input type="number" min="1" bind:value={form.backupRetentionRemote} /></label><label>Local backups to keep<input type="number" min="0" bind:value={form.backupRetentionLocal} /></label><label class="md:col-span-2">Encryption key<input type="password" bind:value={form.encryptionKey} placeholder={status.encryptionConfigured ? 'Already configured; leave blank to keep it' : 'Create and store separately'} /></label></div><div class="flex justify-end gap-2"><button class="btn btn-sm" on:click={testConnection}>Test connection</button><button class="btn btn-sm bg-coollabs" disabled={saving} on:click={save}>{saving ? 'Saving…' : 'Save settings'}</button></div></div>
	<div class="rounded border border-coolgray-500 bg-coolgray-100 p-5"><div class="flex items-center justify-between"><h2 class="text-xl font-bold">Remote backups</h2><button class="btn btn-sm" on:click={listFiles}>Refresh</button></div>{#if files.length}<div class="mt-3 space-y-2">{#each files as file}<div class="flex items-center justify-between border-b border-coolgray-500 py-2"><code>{file.Name}</code><div class="flex gap-2"><button class="btn btn-sm" on:click={() => downloadFile(file.Name)} disabled={!file.Name.endsWith('.age')}>Download</button><button class="btn btn-sm btn-error" on:click={() => deleteFile(file.Name)}>Delete</button></div></div>{/each}</div>{:else}<p class="mt-3 text-sm text-stone-300">No remote files listed yet.</p>{/if}</div>
	<div class="rounded border border-yellow-700 bg-yellow-950/30 p-5 text-sm text-yellow-100"><p>Status: <strong>{status.lastStatus || 'never run'}</strong></p>{#if status.lastAt}<p>Finished: {new Date(status.lastAt).toLocaleString()}</p>{/if}{#if status.lastFile}<p>File: <code>{status.lastFile}</code></p>{/if}<p class="mt-2">Keep the encryption key outside the server. For complete new-server recovery, use <code>scripts/rexify-restore.sh</code>.</p></div>
</div>
{:else}<p>Administrator access is required.</p>{/if}
