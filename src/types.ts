export interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created';
  ports: string;
  created: string;
  size?: string;
  composeProject?: string;
  composeService?: string;
}

export interface ContainerStats {
  id: string;
  name: string;
  cpuPercent: string;
  memUsage: string;
  memPercent: string;
  netIO: string;
  blockIO: string;
  pids: string;
}

export interface Image {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
}

export interface Volume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
}
