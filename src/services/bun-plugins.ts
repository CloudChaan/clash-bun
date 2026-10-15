import {
  bunPluginCommand,
  installBunPlugin,
  listBunPlugins,
  removeBunPlugin,
  setBunPluginEnabled,
} from './cmds'
import { mutate } from './mutate'

export interface BunPlugin {
  manifest: {
    id: string
    name: string
    version: string
    description: string
    capabilities: string[]
    commands: { id: string; label: string }[]
  }
  enabled: boolean
  error: string | null
  dashboard: unknown
  ui: string | null
}

export async function getBunPlugins(): Promise<BunPlugin[]> {
  return (await listBunPlugins()) as unknown as BunPlugin[]
}

export const enablePlugin = (id: string, enabled: boolean) =>
  mutate(() => setBunPluginEnabled(id, enabled), {
    id: 'bun-plugins',
    revalidate: ['bun-plugins'],
  })
export const installPlugin = (directory: string) =>
  mutate(() => installBunPlugin(directory), {
    id: 'bun-plugins',
    revalidate: ['bun-plugins'],
  })
export const removePlugin = (id: string) =>
  mutate(() => removeBunPlugin(id), {
    id: 'bun-plugins',
    revalidate: ['bun-plugins'],
  })
export const runPluginCommand = (id: string, command: string) =>
  mutate(() => bunPluginCommand(id, command), {
    id: 'bun-plugins',
    revalidate: ['bun-plugins'],
  })
