import ExtensionOutlinedIcon from '@mui/icons-material/ExtensionOutlined'
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Switch,
  Typography,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'

import { BasePage } from '@/components/base'
import {
  enablePlugin,
  getBunPlugins,
  installPlugin,
  removePlugin,
  runPluginCommand,
  type BunPlugin,
} from '@/services/bun-plugins'
import { showNotice } from '@/services/notice-service'

function PluginDashboard({ plugin }: { plugin: BunPlugin }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const theme = useTheme()
  const publish = useCallback(() => {
    ref.current?.contentWindow?.postMessage(
      {
        type: 'bun:snapshot',
        dashboard: plugin.dashboard,
        theme: theme.palette.mode,
      },
      '*',
    )
  }, [plugin.dashboard, theme.palette.mode])
  useEffect(() => {
    publish()
    const ready = (event: MessageEvent) => {
      if (
        event.source === ref.current?.contentWindow &&
        event.data?.type === 'bun:ready'
      )
        publish()
    }
    window.addEventListener('message', ready)
    return () => window.removeEventListener('message', ready)
  }, [publish])
  if (!plugin.ui) return null
  return (
    <iframe
      ref={ref}
      title={plugin.manifest.name}
      sandbox="allow-scripts"
      srcDoc={plugin.ui}
      onLoad={publish}
      style={{ width: '100%', height: '75vh', border: 0, borderRadius: 12 }}
    />
  )
}

export default function PluginsPage() {
  const { data: plugins = [], error } = useSWR('bun-plugins', getBunPlugins, {
    refreshInterval: 5000,
  })
  const [active, setActive] = useState('node-stability')
  const [busy, setBusy] = useState(false)
  const selected = plugins.find((p) => p.manifest.id === active)
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } catch {
      /* The shared intent funnel owns command errors. */
    } finally {
      setBusy(false)
    }
  }
  const install = async () => {
    try {
      const directory = await open({
        directory: true,
        multiple: false,
        title: '选择插件目录',
      })
      if (typeof directory === 'string')
        await perform(() => installPlugin(directory))
    } catch (failure) {
      showNotice.error(failure)
    }
  }
  return (
    <BasePage
      title="Clash Bun · 插件"
      header={
        <Button
          disabled={busy}
          onClick={() => {
            void install()
          }}
          startIcon={<ExtensionOutlinedIcon />}
        >
          安装本地插件
        </Button>
      }
    >
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">
          插件随 Clash Bun
          运行，托盘模式下继续监测。关闭插件后停止其任务，保留历史数据。
        </Typography>
        {error && <Alert severity="error">{String(error)}</Alert>}
        {!plugins.length && !error && (
          <Typography color="text.secondary">正在读取插件…</Typography>
        )}
        {plugins.map((plugin) => (
          <Paper
            key={plugin.manifest.id}
            variant="outlined"
            sx={{
              p: 2,
              borderColor:
                active === plugin.manifest.id ? 'primary.main' : 'divider',
            }}
          >
            <Stack
              direction="row"
              sx={{ justifyContent: 'space-between', alignItems: 'center' }}
              spacing={2}
            >
              <Box>
                <Typography sx={{ fontWeight: 700 }}>
                  {plugin.manifest.name}{' '}
                  <Typography
                    component="span"
                    variant="caption"
                    color="text.secondary"
                  >
                    v{plugin.manifest.version}
                  </Typography>
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {plugin.manifest.description}
                </Typography>
              </Box>
              <Switch
                checked={plugin.enabled}
                disabled={busy}
                slotProps={{
                  input: { 'aria-label': `启用 ${plugin.manifest.name}` },
                }}
                onChange={(_, enabled) => {
                  void perform(() => enablePlugin(plugin.manifest.id, enabled))
                }}
              />
            </Stack>
            <Stack direction="row" sx={{ gap: 0.5, flexWrap: 'wrap', mt: 1 }}>
              {plugin.manifest.capabilities.map((capability) => (
                <Chip
                  key={capability}
                  label={capability}
                  size="small"
                  variant="outlined"
                />
              ))}
            </Stack>
            {plugin.error && (
              <Alert sx={{ mt: 1 }} severity="warning">
                {plugin.error}
              </Alert>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button onClick={() => setActive(plugin.manifest.id)}>
                打开看板
              </Button>
              {plugin.manifest.commands.map((command) => (
                <Button
                  key={command.id}
                  disabled={busy || !plugin.enabled}
                  onClick={() => {
                    void perform(() =>
                      runPluginCommand(plugin.manifest.id, command.id),
                    )
                  }}
                >
                  {command.label}
                </Button>
              ))}
              <Button
                color="inherit"
                disabled={busy || plugin.enabled}
                onClick={() => {
                  void perform(() => removePlugin(plugin.manifest.id))
                }}
              >
                卸载并保留数据
              </Button>
            </Stack>
          </Paper>
        ))}
        {selected?.enabled && <PluginDashboard plugin={selected} />}
        {selected && !selected.enabled && (
          <Alert severity="info">
            插件已停用。启用后继续积累近七天的本机可达性数据。
          </Alert>
        )}
      </Stack>
    </BasePage>
  )
}
