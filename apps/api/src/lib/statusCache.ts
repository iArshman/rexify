import { executeCommand } from './common';
import { prisma } from './common';
import { checkContainer } from './docker';

/**
 * v4-style status caching.
 *
 * A background job (see index.ts) periodically computes the status of every
 * application, service and database and stores it in this in-memory cache.
 * The dashboard (`showDashboard`) reads from the cache so it can render the
 * status instantly without waiting for live Docker checks on every page load.
 */

export type ResourceStatus = 'running' | 'degraded' | 'stopped';

type CacheEntry = {
	status: ResourceStatus;
	updatedAt: number;
};

const statusCache: Map<string, CacheEntry> = new Map();

export function setCachedStatus(id: string, status: ResourceStatus) {
	statusCache.set(id, { status, updatedAt: Date.now() });
}

export function getCachedStatus(id: string): ResourceStatus | null {
	return statusCache.get(id)?.status ?? null;
}

export function getAllCachedStatuses(): Record<string, ResourceStatus> {
	const result: Record<string, ResourceStatus> = {};
	for (const [id, entry] of statusCache.entries()) {
		result[id] = entry.status;
	}
	return result;
}

async function computeApplicationStatus(application: any): Promise<ResourceStatus> {
	const { id, buildPack, simpleDockerfile, destinationDocker } = application;
	if (!destinationDocker) return 'stopped';
	const dockerId = destinationDocker.id;
	if (buildPack === 'compose') {
		const { stdout: containers } = await executeCommand({
			dockerId,
			command: `docker ps -a --filter "label=coolify.applicationId=${id}" --format '{{json .}}'`
		});
		const containersArray = containers.trim().split('\n').filter(Boolean);
		if (containersArray.length === 0) return 'stopped';
		let anyRunning = false;
		let anyStopped = false;
		for (const container of containersArray) {
			const state = JSON.parse(container).State;
			if (state === 'running') anyRunning = true;
			else anyStopped = true;
		}
		if (anyRunning && anyStopped) return 'degraded';
		if (anyRunning) return 'running';
		return 'stopped';
	}
	// Single-container application (buildpack or simple Dockerfile)
	void simpleDockerfile;
	const status = await checkContainer({ dockerId, container: id });
	if (status?.found && status.status?.isRunning) return 'running';
	return 'stopped';
}

async function computeServiceStatus(service: any): Promise<ResourceStatus> {
	const { id, destinationDocker } = service;
	if (!destinationDocker) return 'stopped';
	const { stdout: containers } = await executeCommand({
		dockerId: destinationDocker.id,
		command: `docker ps -a --filter "label=com.docker.compose.project=${id}" --format '{{json .}}'`
	});
	const containersArray = containers.trim().split('\n').filter(Boolean);
	if (containersArray.length === 0) return 'stopped';
	let anyRunning = false;
	let anyStopped = false;
	for (const container of containersArray) {
		const state = JSON.parse(container).State;
		if (state === 'running') anyRunning = true;
		else anyStopped = true;
	}
	if (anyRunning && anyStopped) return 'degraded';
	if (anyRunning) return 'running';
	return 'stopped';
}

async function computeDatabaseStatus(database: any): Promise<ResourceStatus> {
	const { id, destinationDocker } = database;
	if (!destinationDocker) return 'stopped';
	try {
		const { stdout } = await executeCommand({
			dockerId: destinationDocker.id,
			command: `docker inspect --format '{{json .State}}' ${id}`
		});
		if (JSON.parse(stdout).Running) return 'running';
	} catch (error) {
		// Container not found / not running
	}
	return 'stopped';
}

let isRefreshing = false;

/**
 * Walks every application, service and database, computes its container status
 * and stores the result in the in-memory cache. Failures for an individual
 * resource are ignored so one broken container can't block the whole refresh.
 */
export async function refreshAllStatuses() {
	if (isRefreshing) return;
	isRefreshing = true;
	try {
		const [applications, services, databases] = await Promise.all([
			prisma.application.findMany({
				where: { destinationDockerId: { not: null } },
				include: { destinationDocker: true, settings: true }
			}),
			prisma.service.findMany({
				where: { destinationDockerId: { not: null } },
				include: { destinationDocker: true }
			}),
			prisma.database.findMany({
				where: { destinationDockerId: { not: null } },
				include: { destinationDocker: true }
			})
		]);

		for (const application of applications) {
			try {
				setCachedStatus(application.id, await computeApplicationStatus(application));
			} catch (error) {
				// Skip this resource on error, keep previous cached value.
			}
		}
		for (const service of services) {
			try {
				setCachedStatus(service.id, await computeServiceStatus(service));
			} catch (error) {
				// Skip
			}
		}
		for (const database of databases) {
			try {
				setCachedStatus(database.id, await computeDatabaseStatus(database));
			} catch (error) {
				// Skip
			}
		}
	} catch (error) {
		console.log('[statusCache] refresh failed', error);
	} finally {
		isRefreshing = false;
	}
}
