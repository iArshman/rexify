<script lang="ts">
	import cuid from 'cuid';
	import { t } from '$lib/translations';
	import { get } from '$lib/api';
	import { appSession } from '$lib/store';
	import NewLocalDocker from './_NewLocalDocker.svelte';
	import NewRemoteDocker from './_NewRemoteDocker.svelte';
	let payload = {};
	let selected = 'localDocker';

	// Build a valid Docker network name from the current team's name.
	// Docker network names must match [a-zA-Z0-9][a-zA-Z0-9_.-]*
	function sanitizeNetworkName(name: string) {
		const sanitized = name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9_.-]+/g, '-')
			.replace(/^[-_.]+/, '')
			.replace(/[-_.]+$/, '');
		return sanitized || cuid();
	}

	async function getDefaultNetwork() {
		try {
			const { team } = await get(`/iam/team/${$appSession.teamId}`);
			if (team?.name) {
				return sanitizeNetworkName(team.name);
			}
		} catch (error) {
			// Fall back to a random network name if the team can't be loaded.
		}
		return cuid();
	}

	async function setPredefined(type: any) {
		selected = type;
		const network = await getDefaultNetwork();
		switch (type) {
			case 'localDocker':
				payload = {
					name: t.get('sources.local_docker'),
					engine: '/var/run/docker.sock',
					remoteEngine: false,
					network,
					isCoolifyProxyUsed: true
				};
				break;
			case 'remoteDocker':
				payload = {
					name: $t('sources.remote_docker'),
					remoteEngine: true,
					remoteIpAddress: null,
					remoteUser: 'root',
					remotePort: 22,
					network,
					isCoolifyProxyUsed: true
				};
				break;
			default:
				break;
		}
	}
</script>

<div class="flex space-x-1 p-6 font-bold">
	<div class="mr-4 text-2xl tracking-tight">{$t('destination.new.add_new_destination')}</div>
</div>
<div class="flex-col space-y-2 pb-10 text-center">
	<div class="text-xl font-bold text-white">{$t('destination.new.predefined_destinations')}</div>
	<div class="flex justify-center space-x-2">
		<button class="btn btn-sm" on:click={() => setPredefined('localDocker')}
			>{$t('sources.local_docker')}</button
		>
		<button class="btn btn-sm" on:click={() => setPredefined('remoteDocker')}>Remote Docker</button>
		<!-- <button class="w-32" on:click={() => setPredefined('kubernetes')}>Kubernetes</button> -->
	</div>
</div>
{#if selected === 'localDocker'}
	<NewLocalDocker {payload} />
{:else if selected === 'remoteDocker'}
	<NewRemoteDocker {payload} />
{:else}
	<div class="text-center font-bold text-4xl py-10">{$t('index.not_implemented_yet')}</div>
{/if}
