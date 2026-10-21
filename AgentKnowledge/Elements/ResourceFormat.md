# 资源结构与直接编辑

常规 agent 写入统一使用 `HybridRef.cmd`。下述结构用于直接阅读与理解 YAML；只有用户明确要求手动编辑时才执行直接写入，不能用它绕过 CLI 故障。

磁盘项目与浏览器运行时数据不同。磁盘 `.hbr` 第 7 版只保存格式、viewport、按类型排列的 ID 与 `asset` 引用；位置尺寸在资源的 `.config`。CLI `inspect` 合并二者，不能把其完整 JSON 原样写回 `.hbr`。

| 类型 | 资源文件 | 配置 format |
| --- | --- | --- |
| 图片 | `Texture_<16位时间哈希>_<8位内容哈希>.png` | `hybridref-texture` |
| 文本 | `Text_<16位时间哈希>_<8位内容哈希>.yaml` | `hybridref-text-layout` |
| 连线 | `Line_<16位时间哈希>_<8位内容哈希>.yaml` | `hybridref-line-layout` |

两个哈希段均使用大写 `0–9/A–F`。新资源时间段是独立毫秒时间戳字符串的 SHA256 前 16 位，之后保持；内容段是最终文件字节 SHA256 前 8 位。配置与资源同 basename，仅扩展名为 `.config`。文件内容使用 UTF-8；推荐 LF。已有 YAML 仅 LF/CRLF 转换可兼容原哈希，其他改动都需重算。

配置的完整结构如下。文本换成对应 format；连线同理：

```yaml
format: hybridref-texture
formatVersion: 1
instances:
  ImageA:
    x: 80
    y: 80
    width: 320
    height: 200
```

一个资源可有多个实例。修改一个 ID 时保留其他实例。ID 在三类元素中全局唯一，允许 1–128 位字母、数字、下划线、连字符；宽高为正数，坐标为有限数，可以为负。同一 ID 只能出现在一个活动资源/config 配对中。

## 直接修改位置和尺寸

1. 用 `element inspect --project <文件> --id <ID>` 获取 `config` 路径和 `configYaml`。
2. 修改 `instances.<ID>` 的 `x/y/width/height`。保持配置 format、版本和其他实例。
3. 保存 UTF-8 配置，不改变资源文件名与内容哈希。
4. 执行 `validate`，再由用户刷新。

## 直接修改内容或样式

1. 读取对应 YAML，或为图片生成最终 PNG 字节。
2. 修改内容，序列化为最终 UTF-8 字节后计算内容哈希。保留原时间哈希，产生新资源名。
3. 写入新内容文件，为该 ID 准备同名新配置，继承当前几何。
4. 从旧配置移除该 ID，保留所有其他实例；为空时保留 `instances: {}`。再发布新配置，使每个 ID 最终只出现一次。
5. 校验，再刷新；刷新更新 `.hbr` 引用，原有排序保留。

旧内容文件可能被 Markdown 或其他实例引用，不应仅因不再属于当前元素就删除。CLI 保留旧内容及不再声明该 ID 的旧配置，不执行全目录资源清理。内容更新可能出现暂时缺失的配对，因此不要在写入过程中刷新。正式 CLI 使用临时文件、外部变更检查和失败回滚；直接编辑同样应遵守完整配对的发布顺序。

[DirectEdit.cjs](Examples/DirectEdit.cjs) 保留为直接 YAML 编辑的教学参考，默认 [Walkthrough.ps1](Examples/Walkthrough.ps1) 不再调用它。它修改 `TextA` 的内容和布局，重新计算哈希、生成新配对，并保留旧配置里的其他实例。仅在用户明确要求验证直接编辑方法时用于示例项目；常规写入使用 CLI 的冲突检查与回滚。

`validate` 只读取文件，报告活动元素的资源格式、哈希、配对、重复 ID 和不可用绑定。损坏项目需要先修复，编辑命令不会在存在校验问题时继续写入。崩溃遗留 `.HybridRefAgent.lock` 时，确认对应进程已退出再手动移除。
