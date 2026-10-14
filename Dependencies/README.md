# HybridRef 本地环境

本目录集中保存 Windows x64 所需的开发与运行环境。系统只需已有 Windows 和 Edge，无需安装 Node.js、pnpm，也不依赖 Codex。已安装完整依赖的文件夹支持离线运行、开发、构建和测试。

```text
Dependencies/
├─ Node/                 # Node.js 24.19.0 可执行文件与许可证
├─ Pnpm/                 # pnpm 11.25.0 及其许可证
├─ Packages/             # 从项目清单生成的安装目录
│  └─ node_modules/      # 运行、构建和测试所需依赖
├─ Cache/                # 可重新生成的安装缓存，不是运行必需品
├─ Environment.json      # 固定版本、官方来源和 Node 校验值
├─ Pnpm.cmd              # 开发命令入口
└─ Setup.cmd             # 显式安装或更新依赖
```

在仓库根目录双击 `Start.cmd` 打开应用；`Start.cmd -Check` 仅检查环境和构建，不打开浏览器。启动始终使用 `Dependencies/Node/node.exe`，依赖齐全时不联网。

开发命令从任意目录调用 `Dependencies/Pnpm.cmd`，包装脚本会定位源码目录并使用本地 Node。例如在仓库根目录执行：

```powershell
.\Dependencies\Pnpm.cmd typecheck
.\Dependencies\Pnpm.cmd test:run
.\Dependencies\Pnpm.cmd build
.\Dependencies\Pnpm.cmd exec playwright test
```

依赖的唯一源清单是 `Code/Module/package.json`、`pnpm-lock.yaml` 与 `pnpm-workspace.yaml`。修改依赖清单后运行 `Dependencies/Setup.cmd`。它在 `Dependencies/Packages` 安装，在 `Dependencies/Cache` 缓存；新增第三方包或缺文件后重装可能需要联网。搬迁后首次执行 Setup 会按新路径重建生成的安装目录；日常启动无需执行 Setup。Packages 中生成的清单不应手动维护。

`Code/Module/node_modules` 是通向此目录中实际依赖的 Windows 目录联接。启动与开发入口会按当前位置修复联接，因此复制项目时应复制 Dependencies 中的实际文件，无需保留旧联接。依赖内部采用普通目录，避免跨路径复制后仍指向原机器。

Node.js 与 pnpm 只保留运行所需文件和许可证；依赖安装按当前锁文件执行，不包含归档 Electron、Whisper 或额外浏览器。精简重复的编译工具与未使用的测试依赖后，仍保留完整的图像服务、开发构建工具及使用系统 Edge 的测试工具，均集中于 `Packages/`；Windows x64 的原生依赖不能直接用于其他平台。

本目录下的 `Packages/` 与 `Cache/` 是 Git 忽略的生成目录。交付现成的离线文件夹时须包含 `Dependencies/Packages/node_modules`；仅获取受版本管理的文件后，需要运行 Setup 安装依赖。

Node 官方二进制来源和 SHA256 见 [Environment.json](Environment.json)，许可证位于 [Node/LICENSE](Node/LICENSE)。pnpm 许可证位于 [Pnpm/LICENSE](Pnpm/LICENSE)，其内含第三方许可证随包保留。
