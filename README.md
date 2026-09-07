# OpsLog Desktop

OpsLog Desktop 是原 `opslog-1.0.11.jar` 的跨平台桌面替代版。界面使用 React，查询、Kibana 访问和文件导出由本机 Tauri/Rust 后端完成，因此访问流量仍从使用者电脑发出，可以直接使用本机 VPN，不需要部署远程查询服务。

## 主要特性

- 支持 macOS 和 Windows，安装后无需 Java、Node.js 或单独启动 Web 服务。
- 交易、应用、ECP、通用日志按 M5/Faulu 约定字段查询。
- 分页、字段选择与顺序记忆、固定操作列、CSV 导出、TRC 下载、Trace 调用链。
- CSV/TRC 直接保存到系统“下载”目录，下载期间按钮锁定，避免重复操作。
- 桌面端启动后静默检查新版本；发现更新时由用户确认下载，数字签名验证通过后安装并重启。
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
- `src-tauri/target/release/bundle/dmg/OpsLog_<版本>_aarch64.dmg`

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
- 自动更新：Windows NSIS 更新包、macOS arm64/x64 更新包、对应数字签名与 `latest.json`。
- `SHA256SUMS`：全部包和更新元数据的完整性校验清单。

Windows ARM64 本轮暂由 Windows x64 包通过系统的 x64 仿真层运行；待引入受支持的 ARM64 Windows 构建与签名环境后，再增加原生 ARM64 包。

对外分发前建议分别配置 Apple Developer ID 和 Windows Authenticode 代码签名，避免系统显示“未知开发者”。内部测试可直接使用未公证/未签名构建。

### macOS 未公证包的首次启动

当前 Release 未使用 Apple Developer ID 签名和公证；只应从本项目的 GitHub Release 下载，并先对照同一 Release 的 `SHA256SUMS` 确认完整性。将应用拖入“应用程序”目录后，如果 macOS 拦截启动，通常只需在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/OpsLog.app
```

该命令只移除下载文件的隔离属性，不会把应用伪装成已由 Apple 签名或公证。若仍提示“无法验证开发者”，请右键应用选择“打开”，或在“系统设置 → 隐私与安全性”中点击“仍要打开”。若仍无法启动，请重新下载并校验 `SHA256SUMS`；不要通过 ad-hoc 重签名来规避问题。

## 自动更新与签名

桌面端使用 Tauri 官方更新机制：启动约 3 秒后静默检查，点击右上角版本号也可手动检查。检测到新版本后会展示版本与更新说明；只有用户确认后才下载，且必须通过内置公钥校验才会安装。Windows 使用被动安装模式，macOS 与 Windows 安装完成后都会重新启动应用。Web 版不执行桌面自动更新。

正式发布构建使用 `src-tauri/tauri.release.conf.json` 开启更新产物，普通本机构建不要求提供签名私钥。GitHub Actions 需要配置以下 Repository Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 私钥全文。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥口令。

当前开发机的私钥保存在 `~/.config/opslog/updater.key`（权限 `0600`），口令保存在 macOS 钥匙串服务 `com.murong.opslog.updater`。私钥、口令和真实环境配置都禁止提交到仓库。配置 Secrets 后，推送 `v*` 标签会生成签名更新包和 `latest.json`，客户端从 GitHub Release 的公开静态地址读取更新信息，无需在应用中保存 GitHub Token。

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
