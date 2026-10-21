# 项目管理

`project create --name <名称> [--root <父目录>]` 创建 `<父目录>/<名称>/<名称>.hbr` 和 `Resource/`。默认父目录是仓库 `Project/`，不受调用工作目录影响。已存在的同名目录会报错，不覆盖。新索引使用第 7 版：

```yaml
format: hybridref
formatVersion: 7
viewport: { x: 0, y: 0, zoom: 1 }
images: []
texts: []
```

`project list [--root <父目录>]` 列出项目文件路径。`project inspect --project <文件.hbr>` 返回扫描资源后的可读元素和问题列表，不保存索引。全部项目路径参数都必须是 `.hbr` 文件，而不是 `Resource` 或目录。

`project delete --project <文件.hbr>` **永久删除整个项目目录及其内容**，无交互确认、无回收目录。仅接受 `.hbr` 与父目录同名的独立项目，且有 `Resource/`；拒绝仓库根目录、仓库的公共目录、包含其他 `.hbr`、Git 元数据或符号链接的目录。先结束对该项目的操作，再删除。

项目创建与删除是项目级操作；元素操作通常只更改资源。CLI 不提供“通过删除资源文件来删除单个元素”的命令：当前刷新会保留缺失引用，文件消失不代表用户要删对象。单个元素删除请在画板中执行。

可运行的完整项目生命周期见 [Walkthrough.ps1](Examples/Walkthrough.ps1)。其中 `project create/list/inspect/delete` 都实际执行；默认测试项目永久删除，`-Keep` 保留以便查看。
