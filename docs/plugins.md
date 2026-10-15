# Clash Bun plugin API v1

See [the host decision](adr/0001-plugin-host.md). The reference plugin is [node-stability](../plugins/node-stability). All project and plugin sources remain GPL-3.0-only.

## Run the development build

Install the pinned Rust toolchain and Node dependencies, then prepare platform resources using `pnpm prebuild`. Run `pnpm bun:dev`, or `pnpm bun:build` to produce a Windows development executable without running the upstream installer. The executable retains the internal filename `clash-verge.exe`; its product name is Clash Bun. Place the executable beside its Mihomo sidecars and resources when copying it elsewhere.

The development app uses `io.github.cloudchaan.clash-bun.dev` for its own data directory and the development service channel. Import a subscription into this app to begin testing; an existing Clash Verge profile is not imported automatically. Exit the existing Clash Verge client before starting this build: the upstream process guard permits only one managed core and is preserved. The separate data directory protects existing profiles; it does not bypass that guard.

Open **Plugins** in the sidebar. Node Stability is bundled and enabled on first launch. It adds `自动选择-稳定`, `自动选择(美国)-稳定`, `自动选择(香港)-稳定`, and `自动选择(台湾)-稳定` during every configuration enhancement. AI, Google, and the US 7891 group expose the US stable group. These three groups become manual selectors so a user can choose the stable group. Other existing explicit choices are retained when possible through Mihomo's selected-node cache.

## Install a local plugin

A plugin directory contains:

```text
manifest.json
main.js
dashboard.html  # optional
```

Choose **Install local plugin**, select its directory, inspect the declared capabilities, and enable it. API v1 accepts only `main.js` and `dashboard.html`, preventing manifest paths from escaping the installed directory. Updates require disabling and removing the old plugin, then installing the new directory. Removal retains historical state; reinstalling the same ID resumes it.

Manifest fields are demonstrated by the reference plugin. `apiVersion` is `1`; `id` is lowercase letters, digits, and hyphens; intervals range from 15 seconds to one day. `commands` contains `{id,label}` entries exposed by the main application. Hooks cannot return asynchronous promises.

## Hooks and effects

`main.js` defines `var bunPlugin = { onConfig, onTick, onResults, onCommand }`. Hooks receive one JSON object and return one JSON object. Each invocation uses a fresh VM; retain durable values in the returned `state`, not global variables.

| Hook | Input | Output |
| --- | --- | --- |
| `onConfig` | `config` | `config` |
| `onTick` | `now`, `online`, `state`, optional `view` | `state`, `actions`, `dashboard` |
| `onResults` | Same inputs plus `results` | `state`, `actions`, `dashboard` |
| `onCommand` | Same inputs plus declared `command` | `state`, `actions`, `dashboard` |

`now` is Unix milliseconds. The proxy `view` follows the existing backend proxy-view contract, with each record augmented by a fingerprint. Core fingerprints hash the source profile and endpoint configuration without the display name. Provider records use provider identity and Mihomo's node ID when exposed; provider endpoint identity cannot be reconstructed if the core omits that ID.

| Capability | Access |
| --- | --- |
| `config:transform` | Transform effective subscription configuration before authoritative app fields are restored |
| `proxies:read` | Read proxy records, group membership and the core's short latency history |
| `proxies:test` | Request `{type:'probe',records:[recordId],url,timeout,tag}` |
| `proxies:select` | Request `{type:'select',group,name}` for an existing selector and member |
| `storage` | Return persistent JSON `state` (32 MiB per plugin) |
| `dashboard` | Return display JSON and provide a sandboxed HTML dashboard |

Probe concurrency is eight. A response with `delay:0` represents a failed reachability test; `delay:null` represents a transport/controller error and must not count as a node failure. The host checks direct local internet connectivity before a batch and again before committing results, skipping measurements when connectivity disappears. It uses [Microsoft's official NCSI HTTP probes and expected response text](https://learn.microsoft.com/en-us/troubleshoot/windows-client/networking/internet-explorer-edge-open-connect-corporate-public-network), rejecting captive portal pages. When both connectivity endpoints are blocked, monitoring pauses conservatively.

The host executes up to three action/result cycles per tick. A hook failure is shown in the plugin card and does not replace the subscription configuration with an invalid hook result. Enablement is persisted before reloading the effective configuration; a reload failure is reported but does not undo the persisted enablement. Stop or remove a plugin only after disabling it; the host serializes this with active probe cycles.

## Dashboard protocol

The HTML dashboard sends `{type:'bun:ready'}` to its parent. The parent sends `{type:'bun:snapshot',dashboard,theme}` on readiness and snapshot changes. `theme` is `light` or `dark`. Check that incoming messages come from `parent`. Dashboards have no command bridge or shared origin with the app; command buttons are generated from the manifest in the trusted main UI.

## Stability measurements

Every five minutes the reference plugin tests all real nodes. It ranks nodes by the proportion of successful scheduled tests within the exact last seven days. Equal success rates are resolved using median successful latency, then name. Watch/recovery tests keep current selection fresh and fail over after a selected node fails. Nodes with no recent successful response are excluded; if a region has none, its group selects `REJECT`.

The dashboard distinguishes scheduled tests from all observations. It absorbs unseen entries in Mihomo's short history ring as supplemental observations, including manual and provider checks that the core reports. The core does not expose a durable stream of every test; observations overwritten between host polls cannot be recovered. The plugin's scheduled tests are recorded independently. Fewer than 24 scheduled samples are marked provisional. Sleep/offline time creates a gap rather than artificial failures.

State lives under the app data directory in `bun-plugins/<id>/state.json`. No controller secret or subscription URL is saved in the plugin state. The previous Python SQLite history is not automatically imported because its node identity and sampling contract differ; leave the old tool in place until the new client is verified with your subscription, then stop it using its existing stop command.

Run `pnpm test:plugins` for selection/window tests and `cargo test -p clash-verge --features clippy --lib bun_plugins::tests` for the Boa/manifest boundary tests. On Windows the `clippy` feature supplies the common-controls manifest needed by test and contract-generator executables; it is not used for the actual development application.
