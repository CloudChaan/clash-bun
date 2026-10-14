# Plugin host and Node Stability development build

Issue: [#1](https://github.com/CloudChaan/clash-bun/issues/1). The [host decision](../adr/0001-plugin-host.md) defines the boundary and the [plugin guide](../plugins.md) defines the API and startup procedure.

Clash Bun now accepts local JavaScript plugins with declared capabilities, backend scheduling, isolated durable JSON state, configuration hooks, and independent sandboxed HTML dashboards. The reference plugin implements local seven-day statistics and global/US/HK/TW selection, with the US choice added to AI, Google, and the US 7891 selector.

The targeted plugin suite passes 14 cases, including exact window expiry, stale or failed winners, provider-only configurations, and recovery from REJECT. Four Rust tests exercise the Boa runtime and check manifest paths, JSON binding, missing host IO, bounded loops, and captive portal rejection. The existing frontend suite passes 45 tests; the production frontend build and architecture checks pass. A Windows development executable was built with `bun-app,dev-sidecar` and a separate app ID.

Native sampling was exercised against an isolated Mihomo fixture with two loopback HTTP tunnels and one unreachable proxy. The plugin wrote successful and failed observations through the named-pipe API, exposed all four generated groups, and changed the global and US selections after the chosen tunnel failed. AI, Google and the US 7891 fixture groups contained the US stable choice. Empty Hong Kong and unreachable Taiwan groups selected REJECT. Restarting the development executable retained the prior samples.

Dashboard search, region filtering, detail expansion, dark mode and empty initialization were checked in a browser using synthetic seven-day data. Those preview numbers are not user measurements.

The upstream managed-core guard prevented a second managed core while the user's original service was active. It remains intact; the integration fixture used its own port and pipe with system proxy and TUN disabled. Normal use requires exiting the original client first. Platform resources for this local build came from the installed upstream package after its prebuild download stalled. No signed installer or update feed is produced at this stage, and the user's real subscription has not been migrated into the development app.
