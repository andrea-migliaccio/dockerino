import { execFile } from 'node:child_process';
import { Container, ContainerStats, Image, Volume } from '../types.js';

function exec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function listContainers(all = true): Promise<Container[]> {
  const args = ['ps', '--format', 'json', '--no-trunc'];
  if (all) args.push('-a');
  const output = await exec(args);
  if (!output.trim()) return [];
  // docker ps --format json outputs one JSON object per line
  return output.trim().split('\n').map((line) => {
    const raw = JSON.parse(line);
    // Parse compose labels from the Labels string (key=value,key=value)
    const labels: Record<string, string> = {};
    if (raw.Labels) {
      for (const pair of String(raw.Labels).split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    return {
      id: raw.ID,
      name: raw.Names,
      image: raw.Image,
      status: raw.Status,
      state: raw.State?.toLowerCase() ?? 'created',
      ports: raw.Ports || '',
      created: raw.CreatedAt || raw.RunningFor || '',
      size: raw.Size,
      composeProject: labels['com.docker.compose.project'],
      composeService: labels['com.docker.compose.service'],
    };
  });
}

export async function getContainerStats(): Promise<ContainerStats[]> {
  const args = ['stats', '--no-stream', '--format', 'json'];
  const output = await exec(args);
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const raw = JSON.parse(line);
    return {
      id: raw.ID,
      name: raw.Name,
      cpuPercent: raw.CPUPerc,
      memUsage: raw.MemUsage,
      memPercent: raw.MemPerc,
      netIO: raw.NetIO,
      blockIO: raw.BlockIO,
      pids: raw.PIDs,
    };
  });
}

export async function startContainer(id: string): Promise<void> {
  await exec(['start', id]);
}

export async function stopContainer(id: string): Promise<void> {
  await exec(['stop', id]);
}

export async function restartContainer(id: string): Promise<void> {
  await exec(['restart', id]);
}

export async function removeContainer(id: string, force = false): Promise<void> {
  const args = ['rm', id];
  if (force) args.push('-f');
  await exec(args);
}

/** Check which shell is available in a container: tries bash first, falls back to sh */
export async function detectShell(containerId: string): Promise<string> {
  try {
    await exec(['exec', containerId, 'test', '-x', '/bin/bash']);
    return '/bin/bash';
  } catch {
    return '/bin/sh';
  }
}

export async function listImages(): Promise<Image[]> {
  const output = await exec(['images', '--format', 'json']);
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const raw = JSON.parse(line);
    return {
      id: raw.ID,
      repository: raw.Repository,
      tag: raw.Tag,
      size: raw.Size,
      created: raw.CreatedSince || raw.CreatedAt || '',
    };
  });
}

export async function removeImage(id: string, force = false): Promise<void> {
  const args = ['rmi', id];
  if (force) args.push('-f');
  await exec(args);
}

export interface ContainerInspect {
  mounts: { type: string; source: string; destination: string; mode: string; rw: boolean }[];
  env: string[];
}

export async function inspectContainer(id: string): Promise<ContainerInspect> {
  const output = await exec(['inspect', '--format', '{{json .}}', id]);
  const raw = JSON.parse(output.trim());
  const mounts = (raw.Mounts ?? []).map((m: Record<string, unknown>) => ({
    type: String(m.Type ?? ''),
    source: String(m.Source ?? ''),
    destination: String(m.Destination ?? ''),
    mode: String(m.Mode ?? ''),
    rw: Boolean(m.RW),
  }));
  const env: string[] = raw.Config?.Env ?? [];
  return { mounts, env };
}

export async function listVolumes(): Promise<Volume[]> {
  const output = await exec(['volume', 'ls', '--format', 'json']);
  if (!output.trim()) return [];
  return output.trim().split('\n').map((line) => {
    const raw = JSON.parse(line);
    return {
      name: raw.Name,
      driver: raw.Driver,
      mountpoint: raw.Mountpoint,
      scope: raw.Scope ?? 'local',
    };
  });
}

export async function removeVolume(name: string, force = false): Promise<void> {
  const args = ['volume', 'rm', name];
  if (force) args.push('-f');
  await exec(args);
}

export interface VolumeInspect {
  createdAt: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
  options: Record<string, string>;
  usedBy: string[]; // container names
}

export async function inspectVolume(name: string): Promise<VolumeInspect> {
  const output = await exec(['volume', 'inspect', '--format', '{{json .}}', name]);
  const raw = JSON.parse(output.trim());

  const labels: Record<string, string> = raw.Labels ?? {};
  const options: Record<string, string> = raw.Options ?? {};

  // Find containers using this volume
  let usedBy: string[] = [];
  try {
    const psOut = await exec(['ps', '-a', '--filter', `volume=${name}`, '--format', '{{.Names}}']);
    usedBy = psOut.trim().split('\n').filter(Boolean);
  } catch { /* no containers */ }

  return {
    createdAt: raw.CreatedAt ?? '',
    driver: raw.Driver ?? '',
    mountpoint: raw.Mountpoint ?? '',
    scope: raw.Scope ?? 'local',
    labels,
    options,
    usedBy,
  };
}
