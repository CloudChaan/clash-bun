## v2.5.9

<details>
<summary><strong> 🐞 修复问题 </strong></summary>

- 修复通过 URL 导入订阅时，即使导入的订阅并非当前使用的订阅，也会重新加载当前配置的问题
- 修复「首页」网站测速失败后卡片一直显示测试中的问题

**🖥️ Windows**

- Windows：修复 Clash Bun 开发版启动时出现多余控制台窗口的问题

**🐧 Linux**

- Linux：修复 deb/rpm 安装包错误包含多余的 `frontend-contract` 可执行文件，导致下游重新打包失败的问题

</details>

<details>
<summary><strong> ✨ 新增功能 </strong></summary>

- 新增 Clash Bun 本地插件管理，支持随应用运行、停用和独立看板
- 新增七天节点稳定性插件，支持美国、香港、台湾稳定自动选择和本机可达性看板

</details>

<details>
<summary><strong> 🚀 优化改进 </strong></summary>


**🖥️ Windows**

- Windows 系统代理默认绕过 `*.local` 域名，访问局域网设备的 `.local` 主机名时不再经过代理

</details>
