# Node Stability

An independent GPL-3.0-only plugin for Clash Bun API v1. Install this directory from the app's Plugins page, then enable it. Clash Bun bundles the same plugin for first launch.

The plugin records seven days of local reachability, creates global and US/HK/TW stable groups, and provides its own HTML dashboard. Scheduled tests run every five minutes and determine success-rate ranking. Watch tests run every host interval, verify the selected nodes, and recover groups with no reachable selection. Manual/core history observations are displayed separately to avoid biased ranking.

Choose `自动选择(美国)-稳定` in AI, Google, or the US 7891 group. Empty or unavailable regions select `REJECT`. Offline and controller errors are excluded from node failures. New statistics accumulate from activation; fewer than 24 scheduled samples are marked provisional.

The core's short history buffer does not expose every historical test. The plugin records its own scheduled measurements durably and absorbs other observations while the core retains them. It does not import the earlier Python daemon's database.

API and development documentation: https://github.com/CloudChaan/clash-bun/blob/feat/plugin-host/docs/plugins.md
