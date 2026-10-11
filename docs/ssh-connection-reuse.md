# SSH 连接复用

## 实现范围

- Web 后端：密码认证通过现有 `ssh2` 保留已认证连接，每条命令独立 channel；并发查询共用握手结果，取消只关闭自己的 channel。
- 桌面 / LAN 后端：密码认证保留原生 `ssh2::Session`，同一服务器命令串行使用连接，不同服务器保持并行。取消正在执行的命令会关闭该连接，下一次操作新建连接，避免残留阻塞任务继续使用它。
- macOS / Unix 的 SSH Config、私钥认证：系统 OpenSSH `ControlMaster=auto`、`ControlPersist=600`；仍尊重 SSH Config 中的跳板机、代理和认证配置。
- Windows 系统 OpenSSH 的 SSH Config / 私钥模式暂不复用：不支持 Unix ControlMaster。Windows 密码模式使用原生连接池，不依赖该机制。此改动没有将 SSH Config 强行转换为原生库，避免破坏 ProxyCommand / ProxyJump 等兼容性。

## 生命周期和安全

连接按环境、服务器配置、账号、认证材料、已确认指纹及连接超时隔离。修改认证配置不能复用原连接。首次指纹确认与密钥变化拒绝策略保持不变。

切换环境时前端释放旧环境连接；保存配置成功后后端清空连接池。进行中的请求不会重新放回已淘汰的池。桌面退出、Web 正常退出时清理连接；空闲约 10 分钟后回收。池最多保留 32 个服务器身份。

连接断开后不重放已经发送的脚本；下一次操作重新连接，避免重复执行。系统复用 socket 放在应用独占、0700 权限的随机临时目录内，不包含密码或业务日志。

多 Web / LAN 客户端操作同一后端时，释放旧环境可能导致另一客户端下一次重新建立连接；密码模式已在执行的请求允许完成，不会重新入池。

## 回归

- `npm test`：包含 Web 密码连接真实本地服务测试和系统 OpenSSH master 复用测试。
- `npm run typecheck`。
- `npm run test:ssh-native`：启动本地 SSH 服务，调用真实 Rust 传输，统计 TCP 连接、成功认证、命令次数，覆盖连续/并发、环境释放、指纹变化、取消后重连。
- `cargo test --lib` / `cargo test --lib --features reader-app`。

测试不读取或修改正式环境配置，不访问业务服务器、不发送日志给外部 AI。Windows 桌面运行时未实测；跨平台原生密码路径通过当前 macOS 环境的真实 SSH 协议测试，不等同于 Windows GUI 验收。
