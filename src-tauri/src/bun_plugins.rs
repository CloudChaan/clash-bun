use crate::{core::handle::Handle, process::AsyncHandler, utils::dirs};
use anyhow::{Context as _, Result, bail};
use boa_engine::{Context, JsString, JsValue, Source, js_string, property::Attribute};
use futures::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serde_yaml_ng::Mapping;
use sha2::{Digest as _, Sha256};
use std::{collections::BTreeMap, path::Path, sync::LazyLock, time::Duration};
use tokio::sync::Mutex;

const BUILTIN_MANIFEST: &str = include_str!("../../plugins/node-stability/manifest.json");
const BUILTIN_ENTRY: &str = include_str!("../../plugins/node-stability/main.js");
const BUILTIN_DASHBOARD: &str = include_str!("../../plugins/node-stability/dashboard.html");
const MAX_JSON: usize = 32 * 1024 * 1024;
const CAPABILITIES: &[&str] = &[
    "config:transform",
    "proxies:read",
    "proxies:test",
    "proxies:select",
    "storage",
    "dashboard",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    id: String,
    name: String,
    version: String,
    api_version: u8,
    description: String,
    license: String,
    entry: String,
    #[serde(default)]
    dashboard: Option<String>,
    #[serde(default)]
    commands: Vec<PluginCommand>,
    interval_seconds: u64,
    capabilities: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct PluginCommand {
    id: String,
    label: String,
}

impl Manifest {
    fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 64
            || !self
                .id
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
        {
            bail!("Plugin IDs must contain lowercase letters, digits, and hyphens");
        }
        if self.api_version != 1 || self.entry != "main.js" || !(15..=86400).contains(&self.interval_seconds) {
            bail!("Unsupported plugin API, entry, or interval");
        }
        if self
            .capabilities
            .iter()
            .any(|cap| !CAPABILITIES.contains(&cap.as_str()))
        {
            bail!("Unsupported plugin capability");
        }
        if self.dashboard.as_deref().is_some_and(|path| path != "dashboard.html") {
            bail!("Unsupported dashboard path");
        }
        Ok(())
    }

    fn allows(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|cap| cap == capability)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Plugin {
    manifest: Manifest,
    enabled: bool,
    #[serde(skip)]
    source: String,
    #[serde(skip)]
    state: Value,
    #[serde(skip)]
    dashboard: Value,
    #[serde(skip)]
    ui: Option<String>,
    #[serde(skip)]
    error: Option<String>,
    #[serde(skip)]
    next_tick: u64,
    #[serde(skip)]
    last_view: Value,
}

#[derive(Default)]
struct Host {
    loaded: bool,
    plugins: BTreeMap<String, Plugin>,
}

static HOST: LazyLock<Mutex<Host>> = LazyLock::new(|| Mutex::new(Host::default()));
static OPERATIONS: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn root() -> Result<std::path::PathBuf> {
    Ok(dirs::app_home_dir()?.join("bun-plugins"))
}

fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_JSON {
        bail!("Plugin storage quota exceeded");
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

impl Host {
    fn load(&mut self) -> Result<()> {
        if self.loaded {
            return Ok(());
        }
        let root = root()?;
        std::fs::create_dir_all(&root)?;
        let registry = root.join("registry.json");
        if registry.exists() {
            self.plugins = serde_json::from_slice(&std::fs::read(registry)?)?;
        } else {
            let manifest: Manifest = serde_json::from_str(BUILTIN_MANIFEST)?;
            self.plugins.insert(
                manifest.id.clone(),
                Plugin {
                    manifest,
                    enabled: true,
                    source: String::new(),
                    state: json!({}),
                    dashboard: Value::Null,
                    ui: None,
                    error: None,
                    next_tick: 0,
                    last_view: Value::Null,
                },
            );
        }
        for (id, plugin) in &mut self.plugins {
            plugin.manifest.validate()?;
            let dir = root.join(id);
            std::fs::create_dir_all(&dir)?;
            plugin.source = if id == "node-stability" && !dir.join("main.js").exists() {
                BUILTIN_ENTRY.to_owned()
            } else {
                std::fs::read_to_string(dir.join("main.js"))?
            };
            plugin.state = if dir.join("state.json").exists() {
                serde_json::from_slice(&std::fs::read(dir.join("state.json"))?)?
            } else {
                json!({})
            };
            plugin.ui = if plugin.manifest.dashboard.is_some() {
                Some(if id == "node-stability" && !dir.join("dashboard.html").exists() {
                    BUILTIN_DASHBOARD.to_owned()
                } else {
                    std::fs::read_to_string(dir.join("dashboard.html"))?
                })
            } else {
                None
            };
        }
        self.save_registry()?;
        self.loaded = true;
        Ok(())
    }

    fn save_registry(&self) -> Result<()> {
        write_json(&root()?.join("registry.json"), &self.plugins)
    }
}

fn eval(source: &str, hook: &str, input: &Value) -> Result<Value> {
    let input = serde_json::to_string(input)?;
    if source.len() > 1024 * 1024 || input.len() > MAX_JSON {
        bail!("Plugin input quota exceeded");
    }
    let mut context = Context::default();
    context.runtime_limits_mut().set_loop_iteration_limit(1_000_000);
    context.runtime_limits_mut().set_recursion_limit(128);
    context
        .register_global_property(
            js_string!("__bun_input__"),
            JsValue::from(JsString::from(input.as_str())),
            Attribute::all(),
        )
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    context
        .eval(Source::from_bytes(source))
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let program = format!(
        "JSON.stringify(typeof bunPlugin.{hook} === 'function' ? bunPlugin.{hook}(JSON.parse(__bun_input__)) : {{}})"
    );
    let output = context
        .eval(Source::from_bytes(&program))
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .to_string(&mut context)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?
        .to_std_string()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if output.len() > MAX_JSON {
        bail!("Plugin output quota exceeded");
    }
    Ok(serde_json::from_str(&output)?)
}

async fn invoke(plugin: &Plugin, hook: &'static str, input: Value) -> Result<Value> {
    let source = plugin.source.clone();
    let work = AsyncHandler::spawn_blocking(move || eval(&source, hook, &input));
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .context("Plugin hook timed out")?
        .context("Plugin hook panicked")?
}

pub async fn transform(config: Mapping) -> Mapping {
    let mut host = HOST.lock().await;
    if let Err(error) = host.load() {
        log::error!("Plugin registry: {error:#}");
        return config;
    }
    let plugins = host
        .plugins
        .values()
        .filter(|p| p.enabled && p.manifest.allows("config:transform"))
        .cloned()
        .collect::<Vec<_>>();
    drop(host);
    let mut value = match serde_json::to_value(&config) {
        Ok(v) => v,
        Err(_) => return config,
    };
    for plugin in plugins {
        match invoke(&plugin, "onConfig", json!({"config": value.clone()})).await {
            Ok(output) => {
                if let Some(next) = output.get("config").filter(|v| v.is_object()) {
                    value = next.clone();
                }
            }
            Err(error) => {
                log::error!("Plugin {} config: {error:#}", plugin.manifest.id);
                if let Some(p) = HOST.lock().await.plugins.get_mut(&plugin.manifest.id) {
                    p.error = Some(error.to_string());
                }
            }
        }
    }
    serde_json::from_value(value).unwrap_or(config)
}

async fn snapshot() -> Result<Value> {
    let view = crate::cmd::proxy::proxy_view(Some(Duration::from_secs(3)))
        .await
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let mut view = serde_json::to_value(view)?;
    let runtime = crate::config::Config::runtime().await;
    let latest = runtime.latest_arc();
    let config = latest.config.as_ref();
    let profile = crate::config::Config::profiles()
        .await
        .latest_arc()
        .current
        .clone()
        .unwrap_or_default();
    if let Some(records) = view["records"].as_object_mut() {
        for record in records.values_mut() {
            let raw = if record["source"]["kind"] == "core" {
                config
                    .and_then(|c| c.get("proxies"))
                    .and_then(|v| v.as_sequence())
                    .and_then(|nodes| {
                        nodes
                            .iter()
                            .find(|n| n.get("name").and_then(|n| n.as_str()) == record["name"].as_str())
                    })
                    .and_then(|n| serde_json::to_value(n).ok())
            } else {
                None
            };
            let mut identity = raw.unwrap_or_else(|| json!({"source": record["source"], "id": record["id"]}));
            if let Some(fields) = identity.as_object_mut() {
                fields.remove("name");
                fields.remove("icon");
            }
            let fingerprint = Sha256::digest(format!("{profile}:{identity}"))
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            record["fingerprint"] = fingerprint.into();
        }
    }
    Ok(view)
}

async fn online() -> bool {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(4))
        .build();
    let Ok(client) = client else {
        return false;
    };
    for (target, expected) in [
        (
            "http://www.msftconnecttest.com/connecttest.txt",
            "Microsoft Connect Test",
        ),
        ("http://www.msftncsi.com/ncsi.txt", "Microsoft NCSI"),
    ] {
        if let Ok(response) = client.get(target).send().await {
            let status = response.status().as_u16();
            if let Ok(body) = response.text().await
                && connectivity_response_matches(status, &body, expected)
            {
                return true;
            }
        }
    }
    false
}

fn connectivity_response_matches(status: u16, body: &str, expected: &str) -> bool {
    status == 200 && body.trim() == expected
}

async fn run_hook(plugin: &mut Plugin, hook: &'static str, command: Option<&str>) -> Result<()> {
    let (view, core_available) = match snapshot().await {
        Ok(view) => {
            plugin.last_view = view.clone();
            (view, true)
        }
        Err(_) => (plugin.last_view.clone(), false),
    };
    let is_online = core_available && online().await;
    let mut input = json!({"now": now(), "state": plugin.state, "online": is_online, "command": command});
    if plugin.manifest.allows("proxies:read") {
        input["view"] = view.clone();
    }
    let mut output = invoke(plugin, hook, input.clone()).await?;
    for _ in 0..3 {
        let actions = output["actions"].as_array().cloned().unwrap_or_default();
        let mut results = Vec::new();
        let mut selection_changed = false;
        for action in actions {
            match action["type"].as_str() {
                Some("probe") => {
                    if !plugin.manifest.allows("proxies:test") {
                        bail!("Missing proxies:test capability");
                    }
                    if input["online"] == false {
                        continue;
                    }
                    let ids = action["records"].as_array().context("Missing probe records")?;
                    if ids.len() > 4096 {
                        bail!("Probe batch quota exceeded");
                    }
                    let url = action["url"].as_str().context("Missing probe URL")?.to_owned();
                    let parsed = reqwest::Url::parse(&url)?;
                    if !matches!(parsed.scheme(), "http" | "https") {
                        bail!("Invalid probe URL");
                    }
                    let timeout = action["timeout"].as_u64().unwrap_or(5000).clamp(1000, 10000) as u32;
                    let tag = action["tag"].as_str().unwrap_or("plugin").to_owned();
                    #[allow(
                        clippy::needless_collect,
                        reason = "Owned targets keep the probe stream Send across the async command boundary"
                    )]
                    let targets = ids
                        .iter()
                        .filter_map(|id| {
                            let id = id.as_str()?;
                            Some((id.to_owned(), view["records"].get(id)?.clone()))
                        })
                        .collect::<Vec<_>>();
                    let measured = stream::iter(targets.into_iter().map(|(id, record)| {
                        let url = url.clone();
                        let tag = tag.clone();
                        async move {
                            let source = &record["source"];
                            let name = source["proxyName"].as_str().unwrap_or("");
                            let request = async {
                                match source["providerName"].as_str() {
                                    Some(provider) => {
                                        Handle::mihomo()
                                            .healthcheck_node_in_provider(provider, name, &url, timeout)
                                            .await
                                    }
                                    None => Handle::mihomo().delay_proxy_by_name(name, &url, timeout).await,
                                }
                            };
                            let delay = tokio::time::timeout(Duration::from_millis(u64::from(timeout) + 2000), request)
                                .await
                                .ok()
                                .and_then(Result::ok)
                                .map(|r| r.delay);
                            json!({"recordId": id, "delay": delay, "tag": tag, "time": now()})
                        }
                    }))
                    .buffer_unordered(8)
                    .collect::<Vec<_>>()
                    .await;
                    results.extend(measured);
                }
                Some("select") => {
                    if !plugin.manifest.allows("proxies:select") {
                        bail!("Missing proxies:select capability");
                    }
                    if input["online"] == false {
                        continue;
                    }
                    let group = action["group"].as_str().context("Missing group")?;
                    let name = action["name"].as_str().context("Missing node")?;
                    let valid = view["groups"].as_array().is_some_and(|groups| {
                        groups.iter().any(|g| {
                            g["name"] == group
                                && g["type"] == "Selector"
                                && (name == "REJECT"
                                    || g["members"].as_array().is_some_and(|members| {
                                        members.iter().any(|m| m["name"] == name && m["kind"] == "node")
                                    }))
                        })
                    });
                    if !valid {
                        bail!("Selection is not a member of a selector group");
                    }
                    Handle::mihomo().select_node_for_group(group, name).await?;
                    selection_changed = true;
                }
                _ => bail!("Unsupported plugin action"),
            }
        }
        if selection_changed {
            crate::core::notify::announce(crate::core::notify::Refresh::Proxies);
        }
        if let Some(state) = output.get("state") {
            if !plugin.manifest.allows("storage") {
                bail!("Missing storage capability");
            }
            write_json(&root()?.join(&plugin.manifest.id).join("state.json"), state)?;
            plugin.state = state.clone();
        }
        if let Some(dashboard) = output.get("dashboard") {
            if !plugin.manifest.allows("dashboard") {
                bail!("Missing dashboard capability");
            }
            plugin.dashboard = dashboard.clone();
        }
        if results.is_empty() {
            break;
        }
        // Connectivity loss during a batch must not become node failures.
        input["online"] = online().await.into();
        if input["online"] == false {
            results.clear();
        }
        input["now"] = now().into();
        input["state"] = plugin.state.clone();
        input["results"] = results.into();
        output = invoke(plugin, "onResults", input.clone()).await?;
    }
    Ok(())
}

pub fn start() {
    AsyncHandler::spawn(|| async {
        let mut timer = tokio::time::interval(Duration::from_secs(5));
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            timer.tick().await;
            let _operation = OPERATIONS.lock().await;
            let mut host = HOST.lock().await;
            if let Err(e) = host.load() {
                log::error!("Plugin host: {e:#}");
                continue;
            }
            let plugins = host
                .plugins
                .values()
                .filter(|p| p.enabled && now() >= p.next_tick)
                .cloned()
                .collect::<Vec<_>>();
            drop(host);
            for mut plugin in plugins {
                plugin.error = run_hook(&mut plugin, "onTick", None).await.err().map(|e| e.to_string());
                plugin.next_tick = now() + plugin.manifest.interval_seconds * 1000;
                HOST.lock().await.plugins.insert(plugin.manifest.id.clone(), plugin);
            }
        }
    });
}

pub async fn list() -> Result<Value> {
    let mut host = HOST.lock().await;
    host.load()?;
    Ok(host
        .plugins
        .values()
        .map(|p| {
            json!({"manifest": p.manifest, "enabled": p.enabled,
        "error": p.error, "dashboard": p.dashboard, "ui": p.ui})
        })
        .collect())
}

pub async fn set_enabled(id: &str, enabled: bool) -> Result<()> {
    let _operation = OPERATIONS.lock().await;
    {
        let mut host = HOST.lock().await;
        host.load()?;
        let plugin = host.plugins.get_mut(id).context("Plugin not installed")?;
        plugin.enabled = enabled;
        plugin.next_tick = 0;
        host.save_registry()?;
    }
    crate::core::CoreManager::global().update_config_checked().await
}

pub async fn install(directory: String) -> Result<()> {
    let _operation = OPERATIONS.lock().await;
    let manifest: Manifest = serde_json::from_slice(&std::fs::read(Path::new(&directory).join("manifest.json"))?)?;
    manifest.validate()?;
    let source = std::fs::read_to_string(Path::new(&directory).join(&manifest.entry))?;
    eval(&source, "onInstall", &json!({}))?;
    let ui = manifest
        .dashboard
        .as_ref()
        .map(|path| std::fs::read_to_string(Path::new(&directory).join(path)))
        .transpose()?;
    if ui.as_ref().is_some_and(|html| html.len() > 1024 * 1024) {
        bail!("Dashboard quota exceeded");
    }
    let mut host = HOST.lock().await;
    host.load()?;
    if host.plugins.contains_key(&manifest.id) {
        bail!("Plugin is already installed; disable and remove it before replacing it");
    }
    let dir = root()?.join(&manifest.id);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("main.js"), &source)?;
    if let Some(html) = &ui {
        std::fs::write(dir.join("dashboard.html"), html)?;
    }
    write_json(&dir.join("manifest.json"), &manifest)?;
    host.plugins.insert(
        manifest.id.clone(),
        Plugin {
            manifest,
            source,
            enabled: false,
            state: json!({}),
            dashboard: Value::Null,
            ui,
            error: None,
            next_tick: 0,
            last_view: Value::Null,
        },
    );
    host.save_registry()
}

pub async fn remove(id: &str) -> Result<()> {
    let _operation = OPERATIONS.lock().await;
    let mut host = HOST.lock().await;
    host.load()?;
    let plugin = host.plugins.get(id).context("Plugin not installed")?;
    if plugin.enabled {
        bail!("Disable the plugin before removing it");
    }
    host.plugins.remove(id);
    host.save_registry()?;
    drop(host);
    // Retain state on disk so reinstalling does not destroy seven days of observations.
    Ok(())
}

pub async fn command(id: &str, command: &str) -> Result<()> {
    let _operation = OPERATIONS.lock().await;
    let mut host = HOST.lock().await;
    host.load()?;
    let mut plugin = host.plugins.get(id).context("Plugin not installed")?.clone();
    if !plugin.enabled {
        bail!("Plugin is disabled");
    }
    if !plugin.manifest.commands.iter().any(|c| c.id == command) {
        bail!("Command not declared by plugin");
    }
    drop(host);
    let result = run_hook(&mut plugin, "onCommand", Some(command)).await;
    plugin.error = result.as_ref().err().map(ToString::to_string);
    HOST.lock().await.plugins.insert(id.to_owned(), plugin);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connectivity_probe_rejects_captive_portals() {
        assert!(connectivity_response_matches(
            200,
            "Microsoft Connect Test\n",
            "Microsoft Connect Test"
        ));
        assert!(!connectivity_response_matches(
            200,
            "<html>Sign in to Wi-Fi</html>",
            "Microsoft Connect Test"
        ));
        assert!(!connectivity_response_matches(
            302,
            "Microsoft Connect Test",
            "Microsoft Connect Test"
        ));
    }

    #[test]
    fn manifest_rejects_path_escape_and_unknown_capabilities() -> Result<()> {
        let mut manifest: Manifest = serde_json::from_str(BUILTIN_MANIFEST)?;
        manifest.entry = "../main.js".into();
        assert!(manifest.validate().is_err());
        manifest.entry = "main.js".into();
        manifest.capabilities.push("shell".into());
        assert!(manifest.validate().is_err());
        Ok(())
    }

    #[test]
    fn vm_binds_json_as_data_and_has_no_host_network_or_filesystem() -> Result<()> {
        let output = eval(
            "var bunPlugin = {onTick(x) {return {value:x.value, fetch:typeof fetch, require:typeof require}}}",
            "onTick",
            &json!({"value": "');throw Error('injection'); //"}),
        )?;
        assert_eq!(output["value"], "');throw Error('injection'); //");
        assert_eq!(output["fetch"], "undefined");
        assert_eq!(output["require"], "undefined");
        Ok(())
    }

    #[test]
    fn runaway_loop_is_bounded_and_reference_plugin_runs_in_boa() -> Result<()> {
        assert!(eval("var bunPlugin={onTick(){while(true){} }}", "onTick", &json!({})).is_err());
        let output = eval(
            BUILTIN_ENTRY,
            "onConfig",
            &json!({"config": {"proxies": [{"name":"美国 A"}]}}),
        )?;
        assert_eq!(output["config"]["proxy-groups"].as_array().map(Vec::len), Some(4));
        Ok(())
    }
}
