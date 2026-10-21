# 尺寸调整

图片等比修改宽度：比例 S=newWidth/oldWidth，newHeight=oldHeight×S。等比修改高度同理。CLI 修改已有元素不会猜测比例，请同时提供两维。

保持中心位置：

```text
newX = oldX + (oldWidth - newWidth) / 2
newY = oldY + (oldHeight - newHeight) / 2
```

保持左上角则不改 x/y。

应用的等宽/等高使用选中图片操作前的算术平均宽/高为目标值，每张图片保持自身比例和中心。所有平均值和中心都先计算，再开始写入。权威实现为 `Geometry.ts` 的 `NormalizeImages`。

文本 `width/height` 是文本框尺寸，字号、行高和 padding 独立。缩小框会换行或裁切，不会自动缩小文字。若要按比例缩放整体文本视觉，需要主动决定是否同时缩放字号和 padding。

自由连线缩放按相对端点缩放，再重算留白；绑定连线通过修改目标位置尺寸改变布局。见 [连线说明](../Elements/Lines.md)。
