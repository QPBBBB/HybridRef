# HybridRef 本地 Agent 知识库

本库面向可以读取本地文件、执行命令的 agent。入口是同目录 `HybridRef.cmd`。使用仓库自带的 Node 和依赖，首次调用或源码改变时自动离线构建 CLI；无需启动浏览器服务。入口可从任意工作目录调用。

## 先了解工作流程

1. 用户先保存 HybridRef 中的编辑。旧项目先在应用中保存，迁移到第 7 版。
2. 用 `project inspect` / `element list` 读取项目和 ID。这些命令也能看到尚未刷新的资源。
3. 创建或编辑资源。已有项目的元素命令不改 `.hbr` 索引。
4. 执行 `validate`，检查 `ok` 和 `issues`。
5. 用户在 HybridRef 点击顶部“刷新”载入；新建的项目先从“打开”菜单选择，再刷新。

浏览器未保存的修改会阻止刷新。执行文件编辑期间不要同时在应用保存或刷新；CLI 会检测准备写入期间的外部变化，但不控制浏览器内存中的草稿。

## 命令速查

命令形式为 `HybridRef.cmd <类型> <动作> <参数>`。`validate` 不带动作。使用 `--help` 获取机器可读帮助。

| 命令 | 必需参数 | 作用 |
| --- | --- | --- |
| `project create` | `--name`，可选 `--root` | 新建独立项目，默认在仓库 `Project/` 下 |
| `project list` | 可选 `--root` | 列出该目录及直接子目录中的 `.hbr` |
| `project inspect` | `--project` | 查看项目和全部可读元素 |
| `project delete` | `--project` | 永久删除独立项目目录和资源 |
| `element list` | `--project` | 列出可读元素、ID、资源路径、布局和内容 |
| `element inspect` | `--project --id` | 查看一个元素，同时输出原始 YAML/config 文本 |
| `element update` | `--project --id` | 修改 `x/y/width/height` |
| `image create/update` | `--project` | 创建、替换图片，编辑布局 |
| `text create/update` | `--project` | 创建、编辑文本内容、样式与布局 |
| `line create/update` | `--project` | 创建、编辑端点、绑定、折线、样式与布局 |
| `validate` | `--project` | 校验扫描结果、有效元素、哈希、ID 和绑定 |

创建时省略 `id` 会生成 UUID；修改时必须提供 ID。复杂参数使用 `--input` 读取 JSON 或 YAML 对象；命令行显式字段覆盖输入文件同名字段。输入是局部修改，不会把省略字段重置。未知字段会报错，避免拼写错误被静默忽略。

CLI 路径相对当前工作目录；`--input` 内的 `source` 相对该输入文件。资源中的路径相对项目目录。以下简单字段也可直接作为参数：`--id --source --content --x --y --width --height --color --thickness --dashed --axis`，只在对应命令中使用。`--dashed` 必须显式传 `true` 或 `false`；嵌套样式和绑定用输入文件。

正常结果在 stdout 输出 JSON，含 `ok`，写入结果含 `changedFiles`、`element`、`requiresRefresh`。中文等非 ASCII 字符使用 JSON Unicode 转义，解析后恢复原文，兼容 Windows 的不同终端编码。错误在 stderr 输出 JSON 并返回非零退出码；`validate` 的问题列表在 stdout，`ok:false` 同时返回非零。读取列表时也应检查 `issues`，不能把不可读元素误判为已删除。依赖初始化失败会在 stderr 输出环境诊断。

## 两类知识

- **元素**：[项目](Elements/Projects.md)、[资源结构与直接编辑](Elements/ResourceFormat.md)、[图片](Elements/Images.md)、[文本](Elements/Texts.md)、[连线](Elements/Lines.md)。
- **对齐**：[坐标](Alignment/Coordinates.md)、[对齐计算](Alignment/Alignment.md)、[尺寸调整](Alignment/Sizing.md)、[数值示例](Alignment/Examples.md)。对齐由 agent 计算，再调用布局修改命令或编辑 config。

## 直接运行完整示例

在仓库根目录执行。脚本使用自己的测试项目，完整执行创建、读取、编辑、对齐、直接 YAML 修改、校验和永久删除，不修改 Demo：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AgentKnowledge\Elements\Examples\Walkthrough.ps1
```

需要保留结果在浏览器中查看时加 `-Keep`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AgentKnowledge\Elements\Examples\Walkthrough.ps1 -Keep
```

脚本输出项目路径。默认目录在 `Code/Module/Runtime/Tests/Examples/`；可以用 `-Root` 指定新位置。默认脚本结束时清理本次创建的 `AgentExample` 项目及自动生成的空父目录，失败时也尝试清理；不删除调用者指定的父目录或已有项目。`-Keep` 明确保留结果，需要查看后再删除。示例文件是实际使用的命令输入，不是伪代码。

## 开发者约定

新增或扩展模块，必须同步交付 agent 可调用接口、参数与结果说明、知识库和可运行示例；模块完成验证时包含 agent 路径。具体要求见 [开发说明](../Code/Module/README.md#agent-接口与知识库维护)。
