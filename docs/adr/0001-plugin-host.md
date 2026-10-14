# JavaScript plugins owned by the application lifecycle

Clash Bun extends Clash Verge Rev with a plugin host in the Rust process. A separate Python daemon cannot follow application shutdown or continue safely when the UI webview is recreated. Configuration extension scripts are one-shot transformations and cannot schedule or persist background work.

Plugins are local directories containing a versioned manifest, `main.js`, and optional `dashboard.html`. The host invokes bounded synchronous JavaScript hooks in Boa and executes declared probe/selection actions through the existing local Mihomo client. JSON state is isolated by plugin ID and atomically replaced. Background work runs independently of the webview; hiding, recreating, or opening the window does not create another scheduler. No external process is launched. If the core is unavailable, the next interval retries without recording node failures.

The first API uses synchronous JSON hooks instead of exposing unrestricted Rust, filesystem, shell, or fetch bindings. Hooks receive only the capabilities declared by the manifest. HTML dashboards run in an opaque-origin iframe with scripts allowed and receive read-only snapshots; they cannot invoke Tauri commands. The main UI owns installation, enablement, removal, and declared commands through the existing intent funnel.

This is a trusted-local-plugin API, not a security boundary for hostile JavaScript. Boa loop/recursion limits and a timeout restrict ordinary runaway hooks, but cannot forcibly terminate every pathological native allocation. Installation starts disabled and the manifest permissions are shown before enabling. Downloads, a marketplace, arbitrary network APIs, and binary plugins are outside API v1.

The first plugin owns its selection rules, seven-day observations, configuration transformation, and dashboard. The host contains no regional filters or stability scoring. Scheduled observations determine ranking; additional core and watch observations remain visible without allowing repeated manual tests to bias the ranking.

Development builds use a separate application ID and development core channel so they can be tested without overwriting an existing Clash Verge profile or connecting to its production service. Upstream update endpoints are disabled for this build. Release branding, installer/service packaging and a signed update feed remain separate release work.
