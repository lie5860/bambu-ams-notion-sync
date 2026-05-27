# 架构设计

本文档记录当前同步服务的架构边界，以及后续扩展 Notion 自愈能力时应遵守的设计约定。

## 设备模型

当前系统以单台打印机为运行单元。

用户登录一个 Bambu Lab 账号后，在 Web 控制台选择一台打印机。服务配置里只保存一个 `BAMBU_PRINTER_SERIAL`，运行时只启动一个 MQTT 客户端，并订阅这一台打印机的上报主题：

```text
device/<printerSerial>/report
```

因此当前版本不支持一个服务实例同时同步多台打印机。未来如需支持多打印机，应将配置提升为 printer registry，并为每台打印机独立维护 MQTT client、运行状态和同步目标。

## AMS 扫描范围

当前 AMS 耗材同步会扫描同一台打印机下的多个 AMS。

Bambu 上报的 AMS 数据位于：

```text
print.ams.ams[]
```

该字段是 AMS 列表。服务会遍历每个 AMS，再遍历其中的 `tray[]` 槽位。槽位标签按 AMS id 生成：

```text
AMS 0 -> A0/A1/A2/A3
AMS 1 -> B0/B1/B2/B3
AMS 2 -> C0/C1/C2/C3
```

当前只同步能识别出 `tag_uid` 或 `tray_uuid` 的槽位。空槽、全 0 的占位耗材会跳过。外置料架 `vt_tray` 暂不属于 AMS 耗材同步范围。

## Notion 目标解析

用户配置的 `NOTION_DATA_SOURCE_ID` 可以是以下任一对象：

- Notion data source id
- Notion database id
- 父页面 id

如果配置的是 data source id，服务直接使用该 data source。

如果配置的是 database id，服务会解析该 database 的第一个 data source 后使用。

如果配置的是父页面 id，服务会在该页面下查找子数据库。子数据库匹配规则保持简单透明：

```text
child_database.title === NOTION_AMS_DATABASE_NAME
```

默认数据库名为：

```text
AMS 耗材
```

如果父页面下不存在同名子数据库，服务会创建一个新的 AMS 子数据库。

这里刻意不保存子数据库的稳定 id。用户如果重命名子数据库，服务会视为原数据库不存在，并在父页面下新建一个配置名称对应的数据库。这是预期行为。

## Notion 字段管理

字段同样按名称匹配，不保存 property id。

服务拥有一组托管字段，例如：

- `AMS 耗材`
- `RFID Tag UID`
- `余量%`
- `剩余克数`
- `材料`
- `料盘重量g`
- `Tray UUID`
- `最后同步时间`

用户可以自由新增、删除、隐藏、排序非托管字段。服务不应该修改这些字段。

服务每次启动时应执行 schema repair，确保托管字段存在且类型正确。同步前如果发现 schema 失效，也可以再次执行 repair 后重试。

## 字段缺失修复

如果托管字段不存在，服务应在当前 AMS 子数据库中创建该字段，并使用系统期望的类型。

示例：

```text
余量% 不存在 -> 创建 number 类型的 余量%
最后同步时间 不存在 -> 创建 date 类型的 最后同步时间
RFID Tag UID 不存在 -> 创建 rich_text 类型的 RFID Tag UID
```

字段缺失不应导致同步永久失败。只要 Notion integration 有权限修改数据库 schema，服务应自动补齐后继续写入。

## 字段类型冲突修复

如果字段名存在，但类型与系统期望不一致，服务应保护用户原字段数据，并创建新的正确字段。

处理流程：

1. 将冲突字段重命名为临时名称。
2. 使用原字段名创建系统需要的字段。
3. 使用新字段继续同步。

临时名称规则：

```text
<原字段名>-temp
<原字段名>-temp-1
<原字段名>-temp-2
```

示例：

```text
用户把 余量% 从 number 改成 rich_text
服务将旧字段重命名为 余量%-temp
服务创建新的 number 类型 余量%
后续同步写入新的 余量%
```

如果临时名称也已存在，则递增后缀直到找到可用名称。

## 标题字段特殊规则

Notion 数据库只能有一个 title 字段，因此 title 字段不能通过“重命名旧字段再创建新字段”的方式修复。

如果系统配置的标题字段名不存在，但数据库中存在一个 title 字段，服务应将现有 title 字段重命名为配置的标题字段名。

默认标题字段名为：

```text
AMS 耗材
```

## 同步流程

推荐同步流程如下：

```text
启动服务
  -> 连接 Bambu MQTT
  -> 解析 Notion 目标
  -> 找到或创建 AMS 子数据库
  -> 执行 schema repair
  -> 订阅打印机状态
  -> 收到 AMS snapshot
  -> 去重 RFID
  -> 查询 Notion 行
  -> 更新或创建耗材页面
```

其中 schema repair 是写入前置条件。服务只有在确认托管字段完整且类型正确后，才应该执行页面写入。

## 设计边界

这套规则的目标是保持系统行为可解释：

- 子数据库按名称匹配，用户改名即视为新目标。
- 字段按名称匹配，用户改名即视为字段缺失。
- 缺失字段自动补齐。
- 类型冲突时保留用户字段，系统重新创建正确字段。
- 用户新增字段、视图、公式、筛选和排序不受影响。

只要父页面仍可访问、同名 AMS 子数据库可创建或可修改，服务就应该能够恢复到可同步状态。

## 打印任务表

打印任务表用于记录同一台打印机的历史任务和实时任务状态。

默认子数据库名为：

```text
打印任务
```

它与 AMS 耗材表一样，位于用户配置的父页面下，并按名称匹配。如果用户重命名 `打印任务` 子数据库，服务会视为不存在，并创建新的同名子数据库。

### 数据来源

打印任务表使用两类数据源：

- MQTT 实时状态：任务开始/暂停/失败/结束、进度、层数、当前 AMS 槽位。
- Bambu Cloud 任务历史：任务名称、打印配置、开始/结束时间、耗材总重量、耗材长度、封面、完成截图。

MQTT 是实时触发源。Bambu Cloud 任务历史是补全和校准源。

### 启动同步

服务启动时默认会分页拉取当前打印机的完整云端任务历史，而不是只拉最近几条。

配置项：

```text
PRINT_TASK_HISTORY_SYNC_ON_START=true
PRINT_TASK_HISTORY_LIMIT=0
PRINT_TASK_HISTORY_PAGE_SIZE=100
```

`PRINT_TASK_HISTORY_LIMIT=0` 表示不限制数量，按接口返回的 total 拉到最旧一条。

### 实时更新策略

打印中的任务由 MQTT 事件驱动更新。

为了避免频繁写 Notion，实时任务写入会节流：

```text
PRINT_TASK_UPDATE_INTERVAL_MS=120000
PRINT_TASK_PROGRESS_STEP=5
```

满足以下任一条件时会写入 Notion：

- 首次发现任务。
- 状态变化。
- 任务进入完成、失败或取消。
- 进度相对上次写入增加至少 `PRINT_TASK_PROGRESS_STEP`。
- 检测到新的 AMS 使用槽位。
- 距上次写入超过 `PRINT_TASK_UPDATE_INTERVAL_MS`。

### 任务主键

打印任务表使用 `任务 Key` 作为逻辑主键。

优先格式：

```text
bambu:<printerSerial>:task:<taskId>
```

例如：

```text
bambu:22E8BJ5C2801961:task:203344493
```

如果没有 `taskId`，则依次使用 `subtaskId`、`projectId + profileId`、`gcode_file + gcode_start_time` 生成 fallback key。

Notion 不提供唯一索引，所以该主键不能提供强事务锁。但多实例并行时，只要看到同一个任务 key，就会更新同一行。

### 并发收敛

如果两个实例同时查不到同一个任务并各自创建，服务会在后续同步中查询同一 `任务 Key` 的所有页面。

收敛规则：

- 保留信息更完整的页面作为主记录。
- 完整度相同则保留创建时间更早的页面。
- 其他重复页面不会删除，而是标记 `同步状态 = 重复`，并写入 `合并到任务 Key`。

写入时采用“只前进”策略：

- 终态不会被运行中覆盖。
- 结束时间不会被空值清除。
- 图片已有 Notion 文件时不再用临时外链覆盖。
- 使用耗材关系只做并集。
- 进度只取更大的值。

### 任务耗材明细

`打印任务.耗材明细` 是从 Bambu Cloud `amsDetailMapping` 拼接出来的兜底文本，不适合作为画廊卡片、统计或筛选的数据源。

结构化展示使用单独的 `打印任务耗材` 子数据库：

- `明细 Key`：`任务 Key:filament:index`，用于幂等更新。
- `打印任务`：relation 到 `打印任务`。
- `材料`、`颜色`、`用量g`、`占比%`：来自 `amsDetailMapping`，是主要展示字段。
- `槽位`：保留为来源排查字段，不放进明细页标题。
- 页面标题：只使用材料和克数，例如 `PLA 1.3g`。
- 页面 icon：使用 `颜色` 生成色块，方便 Notion relation 在画廊中快速识别。

`打印任务` 表会补充 `耗材用量` relation 指向这些明细页。历史任务通常没有稳定 RFID UID，因此这里记录的是“任务实际使用的颜色/材料/用量”，不强行绑定到 `AMS 耗材` 的具体料盘。

### 默认任务视图

服务会把 `打印任务` 数据库的 Notion 自动视图 `Default view` 配置为 gallery：

- 排序：`开始时间` 降序。
- 卡片预览：使用 `完成截图` 文件属性。
- 卡片大小：small。
- 卡片属性：只显示 `打印任务`、`状态`、`耗材用量`。
- 可见属性开启换行显示。

如果 `Default view` 仍是 Notion 自动生成的 table，服务会创建同名 gallery 视图并删除旧 table 视图。用户自己创建的其他视图不会作为程序目标。

### 图片策略

Bambu Cloud 任务历史中的 `cover` 是任务/模型缩略图，`snapShot` 是任务截图。两者都是签名临时链接，不能长期直接放在 Notion 画廊中使用。

服务会下载图片，然后通过 Notion File Upload API 上传为 Notion 文件：

- `任务缩略图`：来自 `cover`。
- `完成截图`：来自 `snapShot`。
- 页面 cover：优先使用 `snapShot`，没有则使用 `cover`。
- 失败任务如果没有 `snapShot`，会复用 `cover` 作为 `完成截图` 和页面 cover。

如果上传失败，服务会临时回退到外链文件，但后续同步发现该字段仍不是 Notion 文件时，会再次尝试上传。
