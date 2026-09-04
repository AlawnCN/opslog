# OpsLog Desktop

OpsLog Desktop 是原 `opslog-1.0.11.jar` 的跨平台桌面替代版。界面使用 React，查询、Kibana 访问和文件导出由本机 Tauri/Rust 后端完成，因此访问流量仍从使用者电脑发出，可以直接使用本机 VPN，不需要部署远程查询服务。

## 主要特性

- 支持 macOS 和 Windows，安装后无需 Java、Node.js 或单独启动 Web 服务。
- 交易、应用、ECP、通用日志按 M5/Faulu 约定字段查询。
- 分页、字段选择与顺序记忆、固定操作列、CSV 导出、TRC 下载、Trace 调用链。
- CSV/TRC 直接保存到系统“下载”目录，下载期间按钮锁定，避免重复操作。
- Kibana 用户名和密码只由本地进程读取，不会交给远程服务器或前端页面。

## 首次使用

1. 启动 OpsLog。
2. 点击右上角“导入配置”，选择兼容原程序的 `opslog-envs.json`。
3. 连接公司 VPN，然后选择环境并查询。

应用不会把真实环境配置打进安装包。导入后配置复制到系统应用配置目录；在 macOS/Linux 上文件权限自动设为 `0600`。

兼容字段：`name`、`kibanaUrl`、`username`、`password`、`txnlstIndex`、`txntrcIndex`、`applogIndex`。另外支持：

- `apmIndex`：APM 索引，缺省为 `traces-apm*`。
- `allowInsecureTls`：仅用于证书无法验证的遗留环境，缺省为 `false`。旧配置中的 Faulu 生产/UAT Kibana IP 会在内存中迁移为对应证书域名，保持严格 TLS 校验。

也可把 `opslog-envs.json` 放在可执行文件旁，或通过 `OPSLOG_CONFIG_PATH` 指定路径，适合内部便携包。

## 开发

需要 Node.js 22+、Rust 1.85+ 和对应平台的 Tauri 系统依赖。

```bash
npm install
npm run desktop:dev
```

保留的浏览器开发模式：

```bash
npm run dev
```

浏览器模式访问 `http://127.0.0.1:5173`，本地查询网关只监听 `127.0.0.1`。

## 构建和分发

必须在目标操作系统上生成正式安装包。

macOS：

```bash
npm run desktop:macos
```

生成 `.app` 和 `.dmg`。当前机器生成的位置：

- `src-tauri/target/release/bundle/macos/OpsLog.app`
- `src-tauri/target/release/bundle/dmg/OpsLog_3.0.8_aarch64.dmg`

Windows x64（在 Windows x64 构建机执行）：

```powershell
npm install
npm run desktop:windows:setup
```

生成 NSIS 安装程序和 `src-tauri/target/release/opslog.exe`。正式 Release 同时提供 `OpsLog_<版本>_windows_x64_setup.exe` 与 `OpsLog_<版本>_windows_x64_portable.zip`；绿色包解压后直接运行 `OpsLog.exe`。目标电脑需有 Microsoft WebView2 Runtime（Windows 10/11 通常已自带）。

每个 GitHub 版本标签自动生成以下完整交付矩阵：

- Windows x64：NSIS 安装版与绿色 ZIP。
- macOS Apple Silicon（arm64）：DMG 与便携 `.app` ZIP。
- macOS Intel（x64）：DMG 与便携 `.app` ZIP。
- `SHA256SUMS`：全部包的完整性校验清单。

Windows ARM64 本轮暂由 Windows x64 包通过系统的 x64 仿真层运行；待引入受支持的 ARM64 Windows 构建与签名环境后，再增加原生 ARM64 包。

对外分发前建议分别配置 Apple Developer ID 和 Windows Authenticode 代码签名，避免系统显示“未知开发者”。内部测试可直接使用未公证/未签名构建。

## 验证

```bash
npm run typecheck
npm test
cd src-tauri && cargo test
```

完整桌面安装包：

```bash
npm run desktop:build
```
